"""Persistenza SQLite (stdlib sqlite3). Il path del DB è configurabile via env DB_PATH."""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

from .calc import YearSettings

DB_PATH = Path(os.environ.get("DB_PATH", "data/app.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS persons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS person_years (
    person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    anno INTEGER NOT NULL,
    reddito REAL NOT NULL DEFAULT 0,
    ritenute REAL NOT NULL DEFAULT 0,
    detrazioni_pregresse REAL NOT NULL DEFAULT 0,
    pregresse_16ter_spesa REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (person_id, anno)
);
CREATE TABLE IF NOT EXISTS eco_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    massimale_detrazione REAL
);
CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    bonus_type TEXT NOT NULL DEFAULT 'ristrutturazione',
    eco_category_id INTEGER REFERENCES eco_categories(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    descrizione TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,             -- ISO yyyy-mm-dd
    importo REAL NOT NULL,
    split TEXT NOT NULL DEFAULT '50_50',  -- '50_50' o person_id
    pagata INTEGER NOT NULL DEFAULT 1,
    detraibile INTEGER NOT NULL DEFAULT 0,  -- 0 = niente bonifico parlante, fuori dai bonus
    bonus_override TEXT,                    -- NULL = eredita il bonus del fornitore
    categoria TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS year_settings (
    anno INTEGER PRIMARY KEY,
    json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prior_deductions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    descrizione TEXT NOT NULL DEFAULT '',
    importo_spesa REAL NOT NULL,
    anno_spesa INTEGER NOT NULL,
    rate_totali INTEGER NOT NULL DEFAULT 10,
    aliquota REAL NOT NULL DEFAULT 0.50
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL DEFAULT '',
    data_inizio TEXT NOT NULL,       -- ISO yyyy-mm-dd
    data_fine TEXT NOT NULL,         -- ISO yyyy-mm-dd (inclusiva)
    predecessori TEXT NOT NULL DEFAULT '',  -- id attività separati da virgola (finish-to-start)
    colore TEXT NOT NULL DEFAULT '#2563eb',
    ordine INTEGER NOT NULL DEFAULT 0
);
"""

# le spese sostenute da quest'anno in poi sono soggette al tetto art. 16-ter
ANNO_INIZIO_16TER = 2025

SEED_ECO_CATEGORIES = [
    ("Infissi e serramenti", 60_000.0),
    ("Caldaie a condensazione / pompe di calore", 30_000.0),
    ("Schermature solari", 60_000.0),
    ("Coibentazione involucro", 60_000.0),
]


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
        # migrazioni additive per DB creati con schemi precedenti
        cols = [r[1] for r in conn.execute("PRAGMA table_info(person_years)")]
        if "pregresse_16ter_spesa" not in cols:
            conn.execute(
                "ALTER TABLE person_years ADD COLUMN pregresse_16ter_spesa REAL NOT NULL DEFAULT 0"
            )
        cols = [r[1] for r in conn.execute("PRAGMA table_info(expenses)")]
        if "detraibile" not in cols:
            conn.execute(
                "ALTER TABLE expenses ADD COLUMN detraibile INTEGER NOT NULL DEFAULT 1"
            )
        if "bonus_override" not in cols:
            conn.execute("ALTER TABLE expenses ADD COLUMN bonus_override TEXT")
        if conn.execute("SELECT COUNT(*) FROM eco_categories").fetchone()[0] == 0:
            conn.executemany(
                "INSERT INTO eco_categories (nome, massimale_detrazione) VALUES (?, ?)",
                SEED_ECO_CATEGORIES,
            )
        if conn.execute("SELECT COUNT(*) FROM persons").fetchone()[0] == 0:
            conn.executemany(
                "INSERT INTO persons (nome) VALUES (?)", [("Persona 1",), ("Persona 2",)]
            )


def settings_for_year(conn: sqlite3.Connection, anno: int) -> YearSettings:
    row = conn.execute("SELECT json FROM year_settings WHERE anno = ?", (anno,)).fetchone()
    if row is None:
        return YearSettings(anno=anno)
    data = json.loads(row["json"])
    data["scaglioni"] = [tuple(s) for s in data.get("scaglioni", [])] or YearSettings(
        anno=anno
    ).scaglioni
    return YearSettings(anno=anno, **{k: v for k, v in data.items() if k != "anno"})


def save_settings(conn: sqlite3.Connection, s: YearSettings) -> None:
    data = {k: v for k, v in s.__dict__.items() if k != "anno"}
    conn.execute(
        "INSERT INTO year_settings (anno, json) VALUES (?, ?) "
        "ON CONFLICT(anno) DO UPDATE SET json = excluded.json",
        (s.anno, json.dumps(data)),
    )


def expenses_for_year(conn: sqlite3.Connection, anno: int) -> list[dict]:
    rows = conn.execute(
        """SELECT e.*, COALESCE(e.bonus_override, s.bonus_type) AS bonus_type,
                  s.eco_category_id, s.nome AS supplier_nome
           FROM expenses e JOIN suppliers s ON s.id = e.supplier_id
           WHERE CAST(strftime('%Y', e.data) AS INTEGER) = ?
           ORDER BY e.data""",
        (anno,),
    ).fetchall()
    return [
        dict(r) | {"pagata": bool(r["pagata"]), "detraibile": bool(r["detraibile"])}
        for r in rows
    ]


def prior_rates_for_year(conn: sqlite3.Connection, anno: int) -> dict[int, tuple[float, float]]:
    """Per persona: (rata annua di detrazione, rata annua di spesa soggetta a 16-ter)
    derivanti dalle voci di anni precedenti attive nell'anno fiscale dato."""
    out: dict[int, tuple[float, float]] = {}
    for r in conn.execute("SELECT * FROM prior_deductions"):
        # rata attiva: la spesa è di un anno passato e la dilazione copre l'anno corrente
        if not (r["anno_spesa"] < anno <= r["anno_spesa"] + r["rate_totali"] - 1):
            continue
        d, s = out.get(r["person_id"], (0.0, 0.0))
        d += r["importo_spesa"] * r["aliquota"] / r["rate_totali"]
        if r["anno_spesa"] >= ANNO_INIZIO_16TER:
            s += r["importo_spesa"] / r["rate_totali"]
        out[r["person_id"]] = (d, s)
    return out


def load_year_inputs(conn: sqlite3.Connection, anno: int) -> dict:
    """Carica tutto ciò che serve a calc.calcola_anno per un anno."""
    persons = [dict(r) for r in conn.execute("SELECT * FROM persons ORDER BY id")]
    person_years = {
        r["person_id"]: dict(r)
        for r in conn.execute("SELECT * FROM person_years WHERE anno = ?", (anno,))
    }
    rates = prior_rates_for_year(conn, anno)
    for p in persons:
        py = person_years.setdefault(p["id"], {"person_id": p["id"], "anno": anno})
        d, s = rates.get(p["id"], (0.0, 0.0))
        py["detrazioni_pregresse"] = d
        py["pregresse_16ter_spesa"] = s
    eco_categories = {
        r["id"]: dict(r) for r in conn.execute("SELECT * FROM eco_categories")
    }
    return {
        "settings": settings_for_year(conn, anno),
        "persons": persons,
        "person_years": person_years,
        "eco_categories": eco_categories,
        "expenses": expenses_for_year(conn, anno),
    }


# ---------- attività / cronoprogramma (Gantt) ----------

TASK_FIELDS = ("nome", "data_inizio", "data_fine", "predecessori", "colore", "ordine")


def list_tasks(conn: sqlite3.Connection) -> list[dict]:
    return [dict(r) for r in conn.execute("SELECT * FROM tasks ORDER BY ordine, id")]


def create_task(conn: sqlite3.Connection, data: dict) -> int:
    ordine = data.get("ordine")
    if ordine is None:
        ordine = (conn.execute("SELECT COALESCE(MAX(ordine), 0) + 1 FROM tasks").fetchone()[0])
    cur = conn.execute(
        "INSERT INTO tasks (nome, data_inizio, data_fine, predecessori, colore, ordine) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            data.get("nome", ""),
            data["data_inizio"],
            data["data_fine"],
            _clean_predecessori(data.get("predecessori", "")),
            data.get("colore", "#2563eb"),
            ordine,
        ),
    )
    return cur.lastrowid


def update_task(conn: sqlite3.Connection, tid: int, data: dict) -> None:
    campi = [c for c in TASK_FIELDS if c in data]
    if not campi:
        return
    vals = []
    for c in campi:
        v = data[c]
        if c == "predecessori":
            v = _clean_predecessori(v)
        vals.append(v)
    set_clause = ", ".join(f"{c} = ?" for c in campi)
    conn.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", (*vals, tid))


def delete_task(conn: sqlite3.Connection, tid: int) -> None:
    conn.execute("DELETE FROM tasks WHERE id = ?", (tid,))
    # rimuovi il riferimento dai predecessori delle altre attività
    for row in conn.execute("SELECT id, predecessori FROM tasks").fetchall():
        ids = [i for i in _parse_ids(row["predecessori"]) if i != tid]
        nuovo = ",".join(str(i) for i in ids)
        if nuovo != (row["predecessori"] or ""):
            conn.execute("UPDATE tasks SET predecessori = ? WHERE id = ?", (nuovo, row["id"]))


def _parse_ids(s: str) -> list[int]:
    out = []
    for part in (s or "").split(","):
        part = part.strip()
        if part:
            try:
                out.append(int(part))
            except ValueError:
                pass
    return out


def _clean_predecessori(s) -> str:
    if isinstance(s, (list, tuple)):
        ids = [int(x) for x in s]
    else:
        ids = _parse_ids(str(s))
    # dedup mantenendo l'ordine
    seen = []
    for i in ids:
        if i not in seen:
            seen.append(i)
    return ",".join(str(i) for i in seen)


def export_all(conn: sqlite3.Connection) -> dict:
    out = {}
    for table in (
        "persons", "person_years", "prior_deductions",
        "eco_categories", "suppliers", "expenses", "year_settings", "tasks",
    ):
        out[table] = [dict(r) for r in conn.execute(f"SELECT * FROM {table}")]
    return out


def import_all(conn: sqlite3.Connection, data: dict) -> None:
    tables = (
        "expenses", "suppliers", "eco_categories",
        "person_years", "prior_deductions", "persons", "year_settings", "tasks",
    )
    for table in tables:  # delete in FK-safe order
        conn.execute(f"DELETE FROM {table}")
    for table in reversed(tables):
        rows = data.get(table, [])
        for row in rows:
            cols = ", ".join(row.keys())
            ph = ", ".join("?" for _ in row)
            conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({ph})", list(row.values()))


# ---------- backup / restore point del DB ----------

BACKUP_NAME_RE = re.compile(r"^(auto|manuale|prerestore)-\d{8}-\d{6}\.db$")
# rotazione: gli auto più vecchi di N giorni vengono eliminati (manuali e prerestore mai)
BACKUP_MAX_AGE_DAYS = float(os.environ.get("BACKUP_MAX_AGE_DAYS", "5"))


def backup_dir() -> Path:
    d = Path(os.environ.get("BACKUP_DIR", DB_PATH.parent / "backups"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def create_backup(tag: str = "manuale") -> str:
    """Snapshot consistente del DB via sqlite backup API. Ritorna il nome del file."""
    assert tag in ("auto", "manuale", "prerestore")
    name = f"{tag}-{datetime.now():%Y%m%d-%H%M%S}.db"
    dest = backup_dir() / name
    with connect() as src, sqlite3.connect(dest) as dst:
        src.backup(dst)
    if tag == "auto":
        _prune_auto_backups()
    return name


def _prune_auto_backups() -> None:
    limite = datetime.now().timestamp() - BACKUP_MAX_AGE_DAYS * 86400
    for f in backup_dir().glob("auto-*.db"):
        if BACKUP_NAME_RE.match(f.name) and f.stat().st_mtime < limite:
            f.unlink()


def list_backups() -> list[dict]:
    out = []
    for f in sorted(backup_dir().glob("*.db"), reverse=True):
        if not BACKUP_NAME_RE.match(f.name):
            continue
        st = f.stat()
        out.append({
            "name": f.name,
            "tag": f.name.split("-")[0],
            "size": st.st_size,
            "mtime": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
        })
    return out


def backup_path(name: str) -> Path:
    """Path validato di un backup esistente (nessun path traversal)."""
    if not BACKUP_NAME_RE.match(name):
        raise ValueError(f"nome backup non valido: {name}")
    p = backup_dir() / name
    if not p.is_file():
        raise FileNotFoundError(name)
    return p


def restore_backup(name: str) -> str:
    """Ripristina uno snapshot. Prima salva lo stato corrente come 'prerestore'."""
    src = backup_path(name)
    safety = create_backup("prerestore")
    shutil.copy2(src, DB_PATH)
    init_db()  # riapplica eventuali migrazioni a snapshot vecchi
    return safety


def delete_backup(name: str) -> None:
    backup_path(name).unlink()
