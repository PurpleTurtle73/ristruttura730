import pytest

from app.calc import YearSettings, calcola_anno, cap_16ter, irpef_lorda, quote_spesa

S = YearSettings(anno=2026)
PERSONS = [{"id": 1, "nome": "Anna"}, {"id": 2, "nome": "Bruno"}]
ECO_CATS = {1: {"nome": "Infissi", "massimale_detrazione": 60_000.0}}


def spesa(importo, bonus="ristrutturazione", split="50_50", pagata=True, eco_cat=None):
    return {
        "importo": importo,
        "split": split,
        "pagata": pagata,
        "bonus_type": bonus,
        "eco_category_id": eco_cat,
        "supplier_id": 1,
        "supplier_nome": "X",
    }


def run(expenses, person_years=None, settings=S, solo_pagate=False):
    return calcola_anno(
        2026,
        settings=settings,
        persons=PERSONS,
        person_years=person_years or {},
        eco_categories=ECO_CATS,
        expenses=expenses,
        solo_pagate=solo_pagate,
    )


def test_irpef_lorda_scaglioni():
    assert irpef_lorda(20_000, S.scaglioni) == 4_600.0
    assert irpef_lorda(30_000, S.scaglioni) == pytest.approx(28_000 * 0.23 + 2_000 * 0.33)
    assert irpef_lorda(60_000, S.scaglioni) == pytest.approx(
        28_000 * 0.23 + 22_000 * 0.33 + 10_000 * 0.43
    )
    assert irpef_lorda(0, S.scaglioni) == 0.0


def test_cap_16ter():
    assert cap_16ter(70_000, S) is None
    assert cap_16ter(75_000, S) is None  # soglia non superata
    assert cap_16ter(80_000, S) == 7_000.0  # 14000 * 0.5
    assert cap_16ter(120_000, S) == 4_000.0  # 8000 * 0.5


def test_quote_spesa():
    e = spesa(1000, split="50_50")
    assert quote_spesa(e, [1, 2]) == {1: 500.0, 2: 500.0}
    e = spesa(1000, split=2)
    assert quote_spesa(e, [1, 2]) == {1: 0.0, 2: 1000.0}


def test_sotto_tetto_nessun_warning():
    r = run([spesa(50_000), spesa(20_000, split=1)])
    assert r["warnings"] == []
    assert r["ristrutturazione"]["totale"] == 70_000.0
    assert r["ristrutturazione"]["residuo"] == 26_000.0
    # Anna: 25k (metà di 50k) + 20k diretti = 45k
    assert r["persone"][1]["spese"]["ristrutturazione"]["spesa"] == 45_000.0
    assert r["persone"][2]["spese"]["ristrutturazione"]["spesa"] == 25_000.0


def test_sforamento_96k_pro_rata():
    r = run([spesa(120_000)])  # 60k a testa, tetto 96k -> 48k detraibili a testa
    assert any("96" in w or "tetto" in w.lower() for w in r["warnings"])
    for pid in (1, 2):
        p = r["persone"][pid]["spese"]["ristrutturazione"]
        assert p["spesa"] == 60_000.0
        assert p["detraibile"] == 48_000.0
        assert p["eccedenza"] == 12_000.0
    assert r["ristrutturazione"]["residuo"] == 0.0


def test_mobili_tetto_5k():
    r = run([spesa(8_000, bonus="mobili")])
    assert any("mobili" in w.lower() for w in r["warnings"])
    assert r["persone"][1]["spese"]["mobili"]["detraibile"] == 2_500.0


def test_eco_massimale_per_categoria():
    # detrazione max 60k a aliquota 50% -> tetto spesa 120k
    r = run([spesa(150_000, bonus="ecobonus", eco_cat=1)])
    assert any("Infissi" in w for w in r["warnings"])
    alloc = r["ecobonus"][1]["per_persona"]
    assert alloc[1]["detraibile"] == 60_000.0
    assert r["ecobonus"][1]["tetto_spesa"] == 120_000.0


def test_eco_aliquota_36_alza_tetto_spesa():
    s = YearSettings(anno=2026, abitazione_principale=False)
    r = run([spesa(100_000, bonus="ecobonus", eco_cat=1)], settings=s)
    assert r["ecobonus"][1]["tetto_spesa"] == pytest.approx(60_000 / 0.36)
    assert r["warnings"] == []


def test_detrazione_e_rata():
    py = {1: {"reddito": 40_000, "ritenute": 9_000, "detrazioni_pregresse": 0}}
    r = run([spesa(40_000, split=1)], person_years=py)
    p = r["persone"][1]
    assert p["detrazione_decennale"] == 20_000.0  # 50%
    assert p["rata_detrazione"] == 2_000.0
    # IRPEF lorda 40k = 6440 + 3960 = 10400; netta = 8400; saldo = 9000-8400 = +600
    assert p["irpef_lorda"] == pytest.approx(10_400.0)
    assert p["saldo_730"] == pytest.approx(600.0)
    assert p["detrazioni_perse"] == 0.0
    assert sum(p["rata_detrazione_breakdown"].values()) == pytest.approx(p["rata_detrazione"])
    assert p["rata_detrazione_breakdown"]["ristrutturazione"] == 2_000.0


def test_breakdown_con_cap_16ter():
    py = {1: {"reddito": 90_000, "ritenute": 30_000, "detrazioni_pregresse": 0}}
    r = run(
        [spesa(80_000, split=1), spesa(40_000, bonus="ecobonus", split=1, eco_cat=1)],
        person_years=py,
    )
    p = r["persone"][1]
    # il fattore 16-ter riduce proporzionalmente tutte le componenti
    assert sum(p["rata_detrazione_breakdown"].values()) == pytest.approx(
        p["rata_detrazione"], abs=0.02
    )


def test_cap_16ter_riduce_detrazione():
    py = {1: {"reddito": 90_000, "ritenute": 30_000, "detrazioni_pregresse": 0}}
    # 96k di spesa solo Anna -> rata spesa 9600 > cap 7000
    r = run([spesa(96_000, split=1)], person_years=py)
    p = r["persone"][1]
    assert p["cap_16ter"] == 7_000.0
    assert p["rata_detrazione"] == pytest.approx(7_000 * 0.5)
    assert any("16-ter" in w for w in r["warnings"])


def test_pregresse_16ter_consumano_il_tetto():
    py = {
        1: {
            "reddito": 90_000,
            "ritenute": 30_000,
            "detrazioni_pregresse": 2_000,
            "pregresse_16ter_spesa": 5_000,
        }
    }
    # cap 7000; pregresse occupano 5000 -> restano 2000 di rata spesa corrente
    # spesa corrente 40k -> rata 4000 > 2000 disponibili -> fattore 0.5
    r = run([spesa(40_000, split=1)], person_years=py)
    p = r["persone"][1]
    assert p["rata_spesa_16ter"] == 9_000.0
    assert p["rata_detrazione"] == pytest.approx(2_000 * 0.5)
    assert any("16-ter" in w and "anni precedenti" in w for w in r["warnings"])
    # senza pregresse soggette al tetto: rata piena
    py2 = {1: {"reddito": 90_000, "ritenute": 30_000, "detrazioni_pregresse": 2_000}}
    r2 = run([spesa(40_000, split=1)], person_years=py2)
    assert r2["persone"][1]["rata_detrazione"] == pytest.approx(4_000 * 0.5)


def test_incapienza_irpef():
    py = {1: {"reddito": 9_000, "ritenute": 2_000, "detrazioni_pregresse": 0}}
    # IRPEF lorda 9000*0.23 = 2070; rata detrazione 96k/10*0.5 = 4800 -> incapienza
    r = run([spesa(96_000, split=1)], person_years=py)
    p = r["persone"][1]
    assert p["irpef_lorda"] == pytest.approx(2_070.0)
    assert p["detrazioni_usate"] == pytest.approx(2_070.0)
    assert p["detrazioni_perse"] == pytest.approx(4_800 - 2_070)
    assert p["irpef_netta"] == 0.0
    assert p["saldo_730"] == pytest.approx(2_000.0)  # tutte le ritenute rimborsate
    assert any("incapienza" in w.lower() for w in r["warnings"])


def test_detrazioni_pregresse_contribuiscono():
    py = {1: {"reddito": 40_000, "ritenute": 11_000, "detrazioni_pregresse": 1_500}}
    r = run([spesa(20_000, split=1)], person_years=py)
    p = r["persone"][1]
    # rata 1000 + pregresse 1500 = 2500; lorda 10400 -> netta 7900; saldo 3100
    assert p["detrazioni_usate"] == pytest.approx(2_500.0)
    assert p["saldo_730"] == pytest.approx(3_100.0)


def test_solo_pagate():
    r = run([spesa(10_000, pagata=True), spesa(30_000, pagata=False)], solo_pagate=True)
    assert r["ristrutturazione"]["totale"] == 10_000.0
    r2 = run([spesa(10_000, pagata=True), spesa(30_000, pagata=False)], solo_pagate=False)
    assert r2["ristrutturazione"]["totale"] == 40_000.0


def test_residuo_fatturabile_vincolo_unita_e_personale():
    py = {
        1: {"reddito": 40_000, "ritenute": 10_000, "detrazioni_pregresse": 0},
        2: {"reddito": 90_000, "ritenute": 30_000, "detrazioni_pregresse": 0},
    }
    r = run([spesa(60_000)], person_years=py)
    residuo_unita = 36_000.0
    # Anna: nessun cap 16-ter, capienza ampia -> limitata dal residuo unità
    assert r["persone"][1]["residuo_fatturabile"]["ristrutturazione"] == residuo_unita
    # Bruno: cap 16-ter 7000/anno; già usa 3000 di rata -> headroom 4000*10 = 40k > 36k
    assert r["persone"][2]["residuo_fatturabile"]["ristrutturazione"] == residuo_unita
    # Bruno con più spese già fatte: headroom personale diventa il vincolo
    r2 = run([spesa(50_000), spesa(40_000, split=2)], person_years=py)
    p2 = r2["persone"][2]
    # rata spesa Bruno = 65k/10 = 6.5k; headroom 16-ter = 500*10 = 5000 < residuo unità 6000
    assert r2["ristrutturazione"]["residuo"] == 6_000.0
    assert p2["residuo_fatturabile"]["ristrutturazione"] == 5_000.0


def test_spese_non_detraibili():
    r = run([spesa(3_000, bonus="nessuno")])
    assert r["persone"][1]["spese"]["non_detraibili"] == 1_500.0
    assert r["ristrutturazione"]["totale"] == 0.0


def test_flag_detraibile_esclude_dai_bonus():
    e = spesa(10_000)  # ristrutturazione, ma senza bonifico parlante
    e["detraibile"] = False
    r = run([e, spesa(20_000)])
    assert r["ristrutturazione"]["totale"] == 20_000.0
    assert r["persone"][1]["spese"]["non_detraibili"] == 5_000.0


def _detraibile_tot(alloc):
    return sum(v["detraibile"] for v in alloc.values())


def test_tetti_mai_superati_con_mix_detraibili_e_non():
    """Sforamento di tutti i tetti con mix detraibili/non: il detraibile resta ai limiti."""
    non_detr = spesa(50_000)
    non_detr["detraibile"] = False
    r = run([
        spesa(150_000),                          # ristrutturazione, oltre 96k
        non_detr,                                # non conta per i bonus
        spesa(9_000, bonus="mobili"),            # oltre 5k
        spesa(200_000, bonus="ecobonus", eco_cat=1),  # oltre tetto spesa 120k (60k/0.5)
        spesa(7_000, bonus="nessuno"),
    ])
    assert _detraibile_tot(r["ristrutturazione"]["per_persona"]) == pytest.approx(96_000.0)
    assert _detraibile_tot(r["mobili"]["per_persona"]) == pytest.approx(5_000.0)
    assert _detraibile_tot(r["ecobonus"][1]["per_persona"]) == pytest.approx(120_000.0)
    # i totali grezzi invece riportano la spesa intera (servono per "quanto ho speso")
    assert r["ristrutturazione"]["totale"] == 150_000.0
    assert r["mobili"]["totale"] == 9_000.0
    # recupero teorico complessivo = somma dei detraibili x aliquota, mai oltre
    teorico = sum(p["detrazione_decennale"] for p in r["persone"].values())
    assert teorico <= (96_000 + 5_000 + 120_000) * 0.5 + 0.01
    # la "spesa detraibile" della dashboard (somma dei campi detraibile) è ai tetti
    spesa_det = (
        _detraibile_tot(r["ristrutturazione"]["per_persona"])
        + _detraibile_tot(r["mobili"]["per_persona"])
        + _detraibile_tot(r["ecobonus"][1]["per_persona"])
    )
    assert spesa_det == pytest.approx(221_000.0)


def test_detrazione_decennale_effettiva_limitata_da_capienza():
    py = {1: {"reddito": 9_000, "ritenute": 2_000, "detrazioni_pregresse": 0}}
    # lorda 2070; rata teorica 4800 -> effettiva 2070/anno
    r = run([spesa(96_000, split=1)], person_years=py)
    p = r["persone"][1]
    assert p["detrazione_decennale"] == pytest.approx(48_000.0)
    assert p["detrazione_decennale_effettiva"] == pytest.approx(20_700.0)


def test_detrazione_decennale_effettiva_con_pregresse():
    py = {1: {"reddito": 9_000, "ritenute": 2_000, "detrazioni_pregresse": 1_000}}
    # lorda 2070; le pregresse hanno priorità -> per le spese correnti restano 1070/anno
    r = run([spesa(96_000, split=1)], person_years=py)
    assert r["persone"][1]["detrazione_decennale_effettiva"] == pytest.approx(10_700.0)


def test_detrazione_decennale_effettiva_capienza_ampia():
    py = {1: {"reddito": 40_000, "ritenute": 11_000, "detrazioni_pregresse": 0}}
    r = run([spesa(20_000, split=1)], person_years=py)
    p = r["persone"][1]
    assert p["detrazione_decennale_effettiva"] == p["detrazione_decennale"]


def test_detrazione_decennale_effettiva_reddito_non_impostato():
    # senza reddito non si può stimare la capienza: si mostra il teorico (come il warning)
    r = run([spesa(20_000, split=1)])
    p = r["persone"][1]
    assert p["detrazione_decennale_effettiva"] == p["detrazione_decennale"]


# --- valori mostrati dalle card della dashboard (logica replicata dal frontend) ---


def _card_bonus(spesa_categoria, detraibile, tetto, aliquota):
    """Replica capCard() del frontend: ritorna le voci mostrate."""
    residuo = max(0.0, tetto - detraibile)
    return {
        "spesa_categoria": spesa_categoria,
        "spesa_categoria_rossa": spesa_categoria > tetto + 0.005,
        "detraibile": detraibile,
        "detraibile_al_tetto": detraibile >= tetto - 0.005,
        "residuo": residuo,
        "residuo_pct": residuo / tetto if tetto else 0.0,
        "residuo_zero": residuo <= 0.005,
        "recupero": detraibile * aliquota,
        "recupero_pct": (detraibile * aliquota) / spesa_categoria if spesa_categoria else 0.0,
        "utilizzo": min(1.0, detraibile / tetto) if tetto else 0.0,
    }


def test_card_bonus_sotto_e_sopra_tetto():
    aliq = 0.5
    # ristrutturazione: 40k detraibili + 30k non detraibili -> categoria 70k, detraibile 40k
    sotto = _card_bonus(70_000, 40_000, 96_000, aliq)
    assert not sotto["spesa_categoria_rossa"]
    assert not sotto["detraibile_al_tetto"]
    assert sotto["residuo"] == 56_000
    assert sotto["recupero"] == 20_000  # 40k * 50%
    assert sotto["recupero_pct"] == pytest.approx(20_000 / 70_000)
    assert sotto["utilizzo"] == pytest.approx(40_000 / 96_000)

    # categoria oltre il cap (anche per soli non detraibili): solo la prima voce è rossa
    over_cat = _card_bonus(120_000, 80_000, 96_000, aliq)
    assert over_cat["spesa_categoria_rossa"]
    assert not over_cat["detraibile_al_tetto"]
    assert not over_cat["residuo_zero"]

    # detraibile al tetto: detraibile, residuo e barra al limite
    pieno = _card_bonus(150_000, 96_000, 96_000, aliq)
    assert pieno["detraibile_al_tetto"]
    assert pieno["residuo"] == 0 and pieno["residuo_zero"]
    assert pieno["utilizzo"] == 1.0
    assert pieno["recupero"] == 48_000


def test_card_dashboard_da_report_reale():
    """Le voci delle card derivano dai campi del report del motore."""
    non_detr = spesa(30_000)        # ristrutturazione non detraibile
    non_detr["detraibile"] = False
    expenses = [
        spesa(64_000),                              # ristrutturazione detraibile
        non_detr,                                   # gonfia la "spesa di categoria"
        spesa(7_000, bonus="ecobonus", eco_cat=1),  # eco detraibile
    ]
    r = run(expenses)
    aliq = r["aliquota"]

    # spesa di categoria = somma grezza per bonus (incl. non detraibili), come nel frontend
    lordo_ristr = sum(e["importo"] for e in expenses if e["bonus_type"] == "ristrutturazione")
    ristr = _card_bonus(lordo_ristr, _detraibile_tot(r["ristrutturazione"]["per_persona"]),
                        r["ristrutturazione"]["tetto"], aliq)
    assert ristr["spesa_categoria"] == 94_000          # 64k + 30k non detraibile
    assert ristr["detraibile"] == 64_000               # solo i detraibili, sotto i 96k
    assert ristr["recupero"] == 32_000
    assert not ristr["spesa_categoria_rossa"]

    eco = _card_bonus(7_000, _detraibile_tot(r["ecobonus"][1]["per_persona"]),
                      r["ecobonus"][1]["tetto_spesa"], aliq)
    assert eco["detraibile"] == 7_000
    assert eco["recupero"] == 3_500

    # Riepilogo appartamento
    spesa_totale = sum(e["importo"] for e in expenses)
    spesa_detraibile = sum(e["importo"] for e in expenses if e.get("detraibile", True))
    # recupero EFFETTIVO = somma delle detrazioni decennali effettive (qui senza
    # redditi impostati = nessun taglio 16-ter/capienza, quindi pari al lordo)
    recupero_10y = sum(p["detrazione_decennale_effettiva"] for p in r["persone"].values())
    recupero_lordo = ristr["recupero"] + eco["recupero"]
    assert spesa_totale == 101_000
    assert spesa_detraibile == 71_000                  # raw flag, non tagliato ai tetti
    assert recupero_lordo == 35_500
    assert recupero_10y == pytest.approx(35_500)       # senza redditi: effettivo = lordo


def test_riepilogo_recupero_effettivo_ridotto_da_capienza():
    """Con reddito basso il 'Recupero in 10 anni' del Riepilogo scende sotto il lordo."""
    py = {1: {"reddito": 9_000, "ritenute": 2_000}}    # lorda 2070/anno
    r = run([spesa(96_000, split=1)], person_years=py)
    p = r["persone"][1]
    recupero_lordo = _detraibile_tot(r["ristrutturazione"]["per_persona"]) * r["aliquota"]
    recupero_eff = sum(x["detrazione_decennale_effettiva"] for x in r["persone"].values())
    assert recupero_lordo == 48_000                     # somma card
    assert recupero_eff == pytest.approx(20_700)        # tagliato dalla capienza IRPEF
    assert recupero_eff < recupero_lordo


def test_card_16ter():
    """Card 16-ter: rata annua di spesa vs cap personale, residuo e utilizzo (opposto)."""
    py = {2: {"reddito": 120_000, "ritenute": 30_000}}  # cap 4000
    r = run([spesa(70_000, split=2)], person_years=py)   # rata = 70k/10 = 7000 > 4000
    p = r["persone"][2]
    cap, rata = p["cap_16ter"], p["rata_spesa_16ter"]
    assert cap == 4_000 and rata == 7_000
    spesa_mostrata = min(rata, cap)
    residuo = max(0.0, cap - rata)
    assert spesa_mostrata == 4_000          # tagliata al cap, rossa
    assert residuo == 0                      # residuo zero
    assert min(1.0, rata / cap) == 1.0       # barra utilizzo piena
