"""API REST + serving frontend statico."""

from __future__ import annotations

import asyncio
import csv
import datetime as dt
import io
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .calc import YearSettings, calcola_anno

STATIC = Path(__file__).parent / "static"


async def _backup_loop(hours: float) -> None:
    while True:
        try:
            db.create_backup("auto")
        except Exception:
            pass
        await asyncio.sleep(hours * 3600)


@asynccontextmanager
async def lifespan(app: FastAPI):
    hours = float(os.environ.get("BACKUP_INTERVAL_HOURS", "24"))
    task = asyncio.create_task(_backup_loop(hours)) if hours > 0 else None
    yield
    if task:
        task.cancel()


app = FastAPI(title="Ristruttura730", lifespan=lifespan)

db.init_db()


class NoCacheStaticFiles(StaticFiles):
    """Il browser rivalida sempre (ETag): dopo un aggiornamento niente JS/CSS stantio."""

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


@app.get("/")
def index():
    # cache-busting: l'URL degli asset cambia ad ogni modifica dei file,
    # così il browser non può mai servire js/css stantii
    v = int(max((STATIC / f).stat().st_mtime for f in ("app.js", "style.css")))
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    for asset in ("/static/app.js", "/static/style.css"):
        html = html.replace(asset, f"{asset}?v={v}")
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


# ---------- persone ----------

@app.get("/api/persons")
def get_persons():
    with db.connect() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM persons ORDER BY id")]


@app.put("/api/persons/{pid}")
def update_person(pid: int, body: dict = Body(...)):
    with db.connect() as conn:
        conn.execute("UPDATE persons SET nome = ? WHERE id = ?", (body["nome"], pid))
    return {"ok": True}


@app.get("/api/person-years/{anno}")
def get_person_years(anno: int):
    with db.connect() as conn:
        return [
            dict(r)
            for r in conn.execute("SELECT * FROM person_years WHERE anno = ?", (anno,))
        ]


@app.put("/api/person-years/{anno}/{pid}")
def put_person_year(anno: int, pid: int, body: dict = Body(...)):
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO person_years (person_id, anno, reddito, ritenute)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(person_id, anno) DO UPDATE SET
                 reddito = excluded.reddito, ritenute = excluded.ritenute""",
            (
                pid,
                anno,
                float(body.get("reddito", 0) or 0),
                float(body.get("ritenute", 0) or 0),
            ),
        )
    return {"ok": True}


# ---------- detrazioni da anni precedenti (voci) ----------

@app.get("/api/prior-deductions")
def get_prior_deductions():
    with db.connect() as conn:
        return [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM prior_deductions ORDER BY anno_spesa DESC, id"
            )
        ]


@app.post("/api/prior-deductions")
def add_prior_deduction(body: dict = Body(...)):
    with db.connect() as conn:
        cur = conn.execute(
            """INSERT INTO prior_deductions
                 (person_id, descrizione, importo_spesa, anno_spesa, rate_totali, aliquota)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                body["person_id"],
                body.get("descrizione", ""),
                float(body["importo_spesa"]),
                int(body["anno_spesa"]),
                int(body.get("rate_totali", 10) or 10),
                float(body.get("aliquota", 0.50)),
            ),
        )
        return {"id": cur.lastrowid}


@app.put("/api/prior-deductions/{did}")
def update_prior_deduction(did: int, body: dict = Body(...)):
    with db.connect() as conn:
        conn.execute(
            """UPDATE prior_deductions SET person_id=?, descrizione=?, importo_spesa=?,
               anno_spesa=?, rate_totali=?, aliquota=? WHERE id=?""",
            (
                body["person_id"],
                body.get("descrizione", ""),
                float(body["importo_spesa"]),
                int(body["anno_spesa"]),
                int(body.get("rate_totali", 10) or 10),
                float(body.get("aliquota", 0.50)),
                did,
            ),
        )
    return {"ok": True}


@app.delete("/api/prior-deductions/{did}")
def delete_prior_deduction(did: int):
    with db.connect() as conn:
        conn.execute("DELETE FROM prior_deductions WHERE id = ?", (did,))
    return {"ok": True}


# ---------- categorie eco ----------

@app.get("/api/eco-categories")
def get_eco_categories():
    with db.connect() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM eco_categories ORDER BY id")]


@app.post("/api/eco-categories")
def add_eco_category(body: dict = Body(...)):
    with db.connect() as conn:
        cur = conn.execute(
            "INSERT INTO eco_categories (nome, massimale_detrazione) VALUES (?, ?)",
            (body["nome"], body.get("massimale_detrazione")),
        )
        return {"id": cur.lastrowid}


@app.put("/api/eco-categories/{cid}")
def update_eco_category(cid: int, body: dict = Body(...)):
    with db.connect() as conn:
        conn.execute(
            "UPDATE eco_categories SET nome = ?, massimale_detrazione = ? WHERE id = ?",
            (body["nome"], body.get("massimale_detrazione"), cid),
        )
    return {"ok": True}


@app.delete("/api/eco-categories/{cid}")
def delete_eco_category(cid: int):
    with db.connect() as conn:
        conn.execute("DELETE FROM eco_categories WHERE id = ?", (cid,))
    return {"ok": True}


# ---------- fornitori ----------

@app.get("/api/suppliers")
def get_suppliers():
    with db.connect() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM suppliers ORDER BY nome")]


@app.post("/api/suppliers")
def add_supplier(body: dict = Body(...)):
    with db.connect() as conn:
        cur = conn.execute(
            "INSERT INTO suppliers (nome, bonus_type, eco_category_id) VALUES (?, ?, ?)",
            (body["nome"], body.get("bonus_type", "ristrutturazione"), body.get("eco_category_id")),
        )
        return {"id": cur.lastrowid}


@app.put("/api/suppliers/{sid}")
def update_supplier(sid: int, body: dict = Body(...)):
    with db.connect() as conn:
        conn.execute(
            "UPDATE suppliers SET nome = ?, bonus_type = ?, eco_category_id = ? WHERE id = ?",
            (body["nome"], body.get("bonus_type"), body.get("eco_category_id"), sid),
        )
    return {"ok": True}


@app.delete("/api/suppliers/{sid}")
def delete_supplier(sid: int):
    with db.connect() as conn:
        n = conn.execute(
            "SELECT COUNT(*) FROM expenses WHERE supplier_id = ?", (sid,)
        ).fetchone()[0]
        if n:
            raise HTTPException(409, f"Fornitore con {n} spese collegate: eliminarle prima.")
        conn.execute("DELETE FROM suppliers WHERE id = ?", (sid,))
    return {"ok": True}


# ---------- spese ----------

@app.get("/api/expenses")
def get_expenses(anno: int | None = None):
    with db.connect() as conn:
        if anno:
            return db.expenses_for_year(conn, anno)
        rows = conn.execute(
            """SELECT e.*, COALESCE(e.bonus_override, s.bonus_type) AS bonus_type,
                      s.eco_category_id, s.nome AS supplier_nome
               FROM expenses e JOIN suppliers s ON s.id = e.supplier_id ORDER BY e.data DESC"""
        ).fetchall()
        return [
            dict(r) | {"pagata": bool(r["pagata"]), "detraibile": bool(r["detraibile"])}
            for r in rows
        ]


@app.post("/api/expenses")
def add_expense(body: dict = Body(...)):
    with db.connect() as conn:
        cur = conn.execute(
            """INSERT INTO expenses
                 (supplier_id, descrizione, data, importo, split, pagata, detraibile, bonus_override, categoria)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                body["supplier_id"],
                body.get("descrizione", ""),
                body["data"],
                float(body["importo"]),
                str(body.get("split", "50_50")),
                1 if body.get("pagata", True) else 0,
                1 if body.get("detraibile", False) else 0,
                body.get("bonus_override") or None,
                body.get("categoria", ""),
            ),
        )
        return {"id": cur.lastrowid}


@app.post("/api/expenses/bulk")
def add_expenses_bulk(body: list[dict] = Body(...)):
    ids = []
    with db.connect() as conn:
        for e in body:
            cur = conn.execute(
                """INSERT INTO expenses
                     (supplier_id, descrizione, data, importo, split, pagata, detraibile, bonus_override, categoria)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    e["supplier_id"],
                    e.get("descrizione", ""),
                    e["data"],
                    float(e["importo"]),
                    str(e.get("split", "50_50")),
                    1 if e.get("pagata", True) else 0,
                    1 if e.get("detraibile", False) else 0,
                    e.get("bonus_override") or None,
                    e.get("categoria", ""),
                ),
            )
            ids.append(cur.lastrowid)
    return {"ids": ids}


@app.put("/api/expenses/{eid}")
def update_expense(eid: int, body: dict = Body(...)):
    with db.connect() as conn:
        conn.execute(
            """UPDATE expenses SET supplier_id=?, descrizione=?, data=?, importo=?,
               split=?, pagata=?, detraibile=?, bonus_override=?, categoria=? WHERE id=?""",
            (
                body["supplier_id"],
                body.get("descrizione", ""),
                body["data"],
                float(body["importo"]),
                str(body.get("split", "50_50")),
                1 if body.get("pagata", True) else 0,
                1 if body.get("detraibile", False) else 0,
                body.get("bonus_override") or None,
                body.get("categoria", ""),
                eid,
            ),
        )
    return {"ok": True}


@app.delete("/api/expenses/{eid}")
def delete_expense(eid: int):
    with db.connect() as conn:
        conn.execute("DELETE FROM expenses WHERE id = ?", (eid,))
    return {"ok": True}


# ---------- settings ----------

@app.get("/api/settings/{anno}")
def get_settings(anno: int):
    with db.connect() as conn:
        return db.settings_for_year(conn, anno).__dict__


@app.put("/api/settings/{anno}")
def put_settings(anno: int, body: dict = Body(...)):
    body.pop("anno", None)
    body["scaglioni"] = [tuple(s) for s in body.get("scaglioni", [])]
    s = YearSettings(anno=anno, **body)
    with db.connect() as conn:
        db.save_settings(conn, s)
    return {"ok": True}


# ---------- report / 730 ----------

@app.get("/api/years")
def get_years():
    with db.connect() as conn:
        anni = [
            r[0]
            for r in conn.execute(
                "SELECT DISTINCT CAST(strftime('%Y', data) AS INTEGER) FROM expenses ORDER BY 1"
            )
        ]
    corrente = dt.date.today().year
    if corrente not in anni:
        anni.append(corrente)
    return sorted(anni)


@app.get("/api/report/{anno}")
def report(anno: int):
    with db.connect() as conn:
        inp = db.load_year_inputs(conn, anno)
    return {
        "tutte": calcola_anno(anno, **inp, solo_pagate=False),
        "solo_pagate": calcola_anno(anno, **inp, solo_pagate=True),
    }


@app.get("/api/caf/{anno}.csv")
def caf_csv(anno: int):
    with db.connect() as conn:
        inp = db.load_year_inputs(conn, anno)
    persons = inp["persons"]
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(
        ["Data", "Fornitore", "Descrizione", "Bonus", "Importo", "Pagata", "Detraibile"]
        + [f"Quota {p['nome']}" for p in persons]
    )
    from .calc import quote_spesa

    pids = [p["id"] for p in persons]
    for e in inp["expenses"]:
        quote = quote_spesa(e, pids)
        w.writerow(
            [
                e["data"],
                e["supplier_nome"],
                e["descrizione"],
                e["bonus_type"],
                f"{e['importo']:.2f}",
                "sì" if e["pagata"] else "no",
                "sì" if e.get("detraibile", True) else "no",
            ]
            + [f"{quote[pid]:.2f}" for pid in pids]
        )
    rep = calcola_anno(anno, **inp, solo_pagate=False)
    w.writerow([])
    w.writerow(["Riepilogo detrazioni (tutte le spese)"])
    for pid, p in rep["persone"].items():
        w.writerow(
            [
                p["nome"],
                f"rata annua detrazione: {p['rata_detrazione']:.2f}",
                f"detrazione decennale: {p['detrazione_decennale']:.2f}",
                f"saldo 730 stimato: {p['saldo_730']:.2f}",
            ]
        )
    return PlainTextResponse(
        buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=caf_{anno}.csv"},
    )


# ---------- backup ----------

@app.get("/api/backups")
def get_backups():
    return db.list_backups()


@app.post("/api/backups")
def create_backup_now():
    return {"name": db.create_backup("manuale")}


@app.post("/api/backups/{name}/restore")
def restore_backup(name: str):
    try:
        safety = db.restore_backup(name)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(404, str(e))
    return {"ok": True, "prerestore": safety}


@app.get("/api/backups/{name}/download")
def download_backup(name: str):
    try:
        path = db.backup_path(name)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(404, str(e))
    return FileResponse(path, filename=name, media_type="application/octet-stream")


@app.delete("/api/backups/{name}")
def delete_backup(name: str):
    try:
        db.delete_backup(name)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(404, str(e))
    return {"ok": True}


@app.get("/api/export")
def export_json():
    with db.connect() as conn:
        return db.export_all(conn)


@app.post("/api/import")
def import_json(body: dict = Body(...)):
    with db.connect() as conn:
        db.import_all(conn, body)
    return {"ok": True}


app.mount("/static", NoCacheStaticFiles(directory=STATIC), name="static")
