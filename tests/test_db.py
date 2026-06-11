import pytest

from app import db


@pytest.fixture
def tmp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "app.db")
    monkeypatch.setenv("BACKUP_DIR", str(tmp_path / "backups"))
    db.init_db()
    return tmp_path


def add_pregressa(person_id, importo, anno, rate=10, aliquota=0.5, descr=""):
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO prior_deductions
                 (person_id, descrizione, importo_spesa, anno_spesa, rate_totali, aliquota)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (person_id, descr, importo, anno, rate, aliquota),
        )


def test_prior_rates_finestra_e_16ter(tmp_db):
    add_pregressa(1, 20_000, 2024)          # ante 2025: niente 16-ter
    add_pregressa(1, 10_000, 2025)          # dal 2025: soggetta a 16-ter
    add_pregressa(1, 50_000, 2026)          # anno corrente: non è "pregressa" nel 2026
    add_pregressa(2, 6_000, 2024, rate=2)   # ultima rata nel 2025: non attiva nel 2026
    with db.connect() as conn:
        rates = db.prior_rates_for_year(conn, 2026)
    assert rates[1] == (pytest.approx(1_000 + 500), pytest.approx(1_000.0))
    assert 2 not in rates
    # nel 2025 la voce a 2 rate di persona 2 è attiva
    with db.connect() as conn:
        rates25 = db.prior_rates_for_year(conn, 2025)
    assert rates25[2] == (pytest.approx(6_000 * 0.5 / 2), 0.0)


def test_load_year_inputs_inietta_pregresse(tmp_db):
    add_pregressa(1, 20_000, 2025)
    with db.connect() as conn:
        inp = db.load_year_inputs(conn, 2026)
    py = inp["person_years"][1]
    assert py["detrazioni_pregresse"] == pytest.approx(1_000.0)
    assert py["pregresse_16ter_spesa"] == pytest.approx(2_000.0)
    # persona senza voci: zero, ma presente
    assert inp["person_years"][2]["detrazioni_pregresse"] == 0.0


def test_backup_create_restore_roundtrip(tmp_db):
    with db.connect() as conn:
        conn.execute("UPDATE persons SET nome = 'Originale' WHERE id = 1")
    snap = db.create_backup("manuale")
    assert any(b["name"] == snap for b in db.list_backups())

    with db.connect() as conn:
        conn.execute("UPDATE persons SET nome = 'Modificato' WHERE id = 1")
    safety = db.restore_backup(snap)
    with db.connect() as conn:
        nome = conn.execute("SELECT nome FROM persons WHERE id = 1").fetchone()[0]
    assert nome == "Originale"
    # lo snapshot di sicurezza contiene lo stato pre-ripristino
    assert safety.startswith("prerestore-")
    assert any(b["name"] == safety for b in db.list_backups())

    db.delete_backup(snap)
    assert not any(b["name"] == snap for b in db.list_backups())


def test_rotazione_auto_per_eta(tmp_db):
    import os
    import time

    vecchio = db.backup_dir() / "auto-20200101-000000.db"
    vecchio.write_bytes(b"x")
    sei_giorni_fa = time.time() - 6 * 86400
    os.utime(vecchio, (sei_giorni_fa, sei_giorni_fa))
    manuale_vecchio = db.backup_dir() / "manuale-20200101-000000.db"
    manuale_vecchio.write_bytes(b"x")
    os.utime(manuale_vecchio, (sei_giorni_fa, sei_giorni_fa))

    db.create_backup("auto")  # innesca la rotazione

    assert not vecchio.exists()  # auto oltre i 5 giorni: eliminato
    assert manuale_vecchio.exists()  # i manuali non si toccano
    assert any(b["tag"] == "auto" for b in db.list_backups())  # il nuovo c'è


def test_backup_nome_invalido(tmp_db):
    with pytest.raises(ValueError):
        db.backup_path("../../../etc/passwd")
    with pytest.raises(ValueError):
        db.backup_path("altro-20260101-000000.db")


def test_export_include_prior_deductions(tmp_db):
    add_pregressa(1, 9_000, 2025, descr="vecchio bagno")
    with db.connect() as conn:
        dump = db.export_all(conn)
        assert dump["prior_deductions"][0]["descrizione"] == "vecchio bagno"
        db.import_all(conn, dump)
        n = conn.execute("SELECT COUNT(*) FROM prior_deductions").fetchone()[0]
    assert n == 1
