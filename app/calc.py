"""Motore di calcolo detrazioni: funzioni pure, nessun accesso al DB.

Convenzioni:
- importi in euro (float, arrotondati a 2 decimali in output)
- bonus_type: "ristrutturazione" | "ecobonus" | "mobili" | "nessuno"
- split di una spesa: "50_50" oppure l'id (int) della persona che la sostiene
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

RATE_ANNUALI = 10


@dataclass
class YearSettings:
    anno: int
    abitazione_principale: bool = True
    aliquota_prima_casa: float = 0.50
    aliquota_altre: float = 0.36
    tetto_ristrutturazione: float = 96_000.0
    tetto_mobili: float = 5_000.0
    # scaglioni IRPEF: lista di (limite_superiore | None, aliquota)
    scaglioni: list[tuple[float | None, float]] = field(
        default_factory=lambda: [(28_000.0, 0.23), (50_000.0, 0.33), (None, 0.43)]
    )
    # art. 16-ter TUIR (spese dal 2025): tetto spese detraibili per redditi alti
    cap16ter_soglia: float = 75_000.0
    cap16ter_base_fascia1: float = 14_000.0  # reddito 75k-100k
    cap16ter_soglia2: float = 100_000.0
    cap16ter_base_fascia2: float = 8_000.0  # reddito > 100k
    cap16ter_coefficiente: float = 0.50  # senza figli a carico

    @property
    def aliquota(self) -> float:
        return self.aliquota_prima_casa if self.abitazione_principale else self.aliquota_altre


def irpef_lorda(reddito: float, scaglioni: list[tuple[float | None, float]]) -> float:
    """IRPEF lorda a scaglioni sul reddito imponibile."""
    imposta = 0.0
    precedente = 0.0
    for limite, aliquota in scaglioni:
        if limite is None or reddito <= limite:
            imposta += max(0.0, reddito - precedente) * aliquota
            break
        imposta += (limite - precedente) * aliquota
        precedente = limite
    return round(max(0.0, imposta), 2)


def cap_16ter(reddito: float, s: YearSettings) -> float | None:
    """Tetto annuo di spese detraibili (None = nessun tetto)."""
    if reddito <= s.cap16ter_soglia:
        return None
    base = s.cap16ter_base_fascia1 if reddito <= s.cap16ter_soglia2 else s.cap16ter_base_fascia2
    return base * s.cap16ter_coefficiente


def quote_spesa(expense: dict, person_ids: list[int]) -> dict[int, float]:
    """Ripartisce una spesa tra le persone secondo lo split."""
    split = expense["split"]
    if split == "50_50":
        return {pid: expense["importo"] / 2 for pid in person_ids}
    pid = int(split)
    return {p: (expense["importo"] if p == pid else 0.0) for p in person_ids}


def _alloca_tetto(spese_per_persona: dict[int, float], tetto: float) -> dict[int, dict]:
    """Applica un tetto per unità immobiliare: se la somma sfora, riduzione pro-rata."""
    totale = sum(spese_per_persona.values())
    fattore = 1.0 if totale <= tetto or totale == 0 else tetto / totale
    out = {}
    for pid, spesa in spese_per_persona.items():
        detraibile = spesa * fattore
        out[pid] = {
            "spesa": round(spesa, 2),
            "detraibile": round(detraibile, 2),
            "eccedenza": round(spesa - detraibile, 2),
        }
    return out


def calcola_anno(
    anno: int,
    settings: YearSettings,
    persons: list[dict],  # [{id, nome}]
    person_years: dict[int, dict],  # person_id -> {reddito, ritenute, detrazioni_pregresse}
    eco_categories: dict[int, dict],  # id -> {nome, massimale_detrazione}
    expenses: list[dict],  # spese dell'anno, già join con supplier:
    #   {importo, split, pagata, bonus_type, eco_category_id, supplier_id, supplier_nome}
    solo_pagate: bool = False,
) -> dict[str, Any]:
    """Calcolo completo per un anno fiscale. Ritorna struttura per dashboard/730."""
    person_ids = [p["id"] for p in persons]
    if solo_pagate:
        expenses = [e for e in expenses if e["pagata"]]

    warnings: list[str] = []

    # --- aggregazione spese per bucket ---
    ristr: dict[int, float] = {pid: 0.0 for pid in person_ids}
    mobili: dict[int, float] = {pid: 0.0 for pid in person_ids}
    eco: dict[int, dict[int, float]] = {}  # cat_id -> {pid: spesa}
    non_detraibili: dict[int, float] = {pid: 0.0 for pid in person_ids}

    for e in expenses:
        quote = quote_spesa(e, person_ids)
        # senza bonifico parlante la spesa non va in alcun bonus
        bt = e["bonus_type"] if e.get("detraibile", True) else "nessuno"
        if bt == "ristrutturazione":
            for pid, q in quote.items():
                ristr[pid] += q
        elif bt == "mobili":
            for pid, q in quote.items():
                mobili[pid] += q
        elif bt == "ecobonus":
            cat = e.get("eco_category_id")
            bucket = eco.setdefault(cat, {pid: 0.0 for pid in person_ids})
            for pid, q in quote.items():
                bucket[pid] += q
        else:
            for pid, q in quote.items():
                non_detraibili[pid] += q

    aliquota = settings.aliquota

    # --- ristrutturazione: tetto 96k sulla spesa per unità ---
    ristr_alloc = _alloca_tetto(ristr, settings.tetto_ristrutturazione)
    tot_ristr = sum(v["spesa"] for v in ristr_alloc.values())
    if tot_ristr > settings.tetto_ristrutturazione:
        warnings.append(
            f"Ristrutturazione {anno}: spesa totale €{tot_ristr:,.0f} supera il tetto "
            f"€{settings.tetto_ristrutturazione:,.0f} per unità immobiliare: "
            f"€{tot_ristr - settings.tetto_ristrutturazione:,.0f} non detraibili."
        )

    # --- mobili: tetto 5k sulla spesa per unità ---
    mobili_alloc = _alloca_tetto(mobili, settings.tetto_mobili)
    tot_mobili = sum(v["spesa"] for v in mobili_alloc.values())
    if tot_mobili > settings.tetto_mobili:
        warnings.append(
            f"Bonus mobili {anno}: spesa totale €{tot_mobili:,.0f} supera il tetto "
            f"€{settings.tetto_mobili:,.0f} per unità immobiliare."
        )

    # --- ecobonus: massimale di DETRAZIONE per categoria -> tetto spesa = max/aliquota ---
    eco_alloc: dict[int, dict] = {}
    for cat_id, spese in eco.items():
        cat = eco_categories.get(cat_id, {"nome": "Senza categoria", "massimale_detrazione": None})
        max_detr = cat.get("massimale_detrazione")
        tetto_spesa = (max_detr / aliquota) if max_detr else float("inf")
        alloc = _alloca_tetto(spese, tetto_spesa)
        tot = sum(v["spesa"] for v in alloc.values())
        if tot > tetto_spesa:
            warnings.append(
                f"Ecobonus '{cat['nome']}' {anno}: spesa €{tot:,.0f} supera il tetto "
                f"€{tetto_spesa:,.0f} (detrazione max €{max_detr:,.0f})."
            )
        eco_alloc[cat_id] = {
            "nome": cat["nome"],
            "massimale_detrazione": max_detr,
            "tetto_spesa": None if tetto_spesa == float("inf") else round(tetto_spesa, 2),
            "per_persona": alloc,
        }

    # --- per persona: detrazione, cap 16-ter, capienza IRPEF, liquidazione 730 ---
    persone_out = {}
    for p in persons:
        pid = p["id"]
        py = person_years.get(pid, {})
        reddito = py.get("reddito", 0.0) or 0.0
        ritenute = py.get("ritenute", 0.0) or 0.0
        pregresse = py.get("detrazioni_pregresse", 0.0) or 0.0
        # rata annua di SPESA da anni precedenti soggetta al tetto 16-ter (spese dal 2025);
        # le rate di spese ante-2025 sono escluse dal tetto e non vanno indicate qui
        pregresse_16ter = py.get("pregresse_16ter_spesa", 0.0) or 0.0

        spesa_ristr_det = ristr_alloc[pid]["detraibile"]
        spesa_mobili_det = mobili_alloc[pid]["detraibile"]
        spesa_eco_det = sum(c["per_persona"][pid]["detraibile"] for c in eco_alloc.values())

        # rate annuali (quota di spesa che "pesa" sull'anno ai fini 16-ter)
        rata_spesa = (spesa_ristr_det + spesa_mobili_det + spesa_eco_det) / RATE_ANNUALI

        cap = cap_16ter(reddito, settings)
        fattore_cap = 1.0
        rata_spesa_16ter = rata_spesa + pregresse_16ter
        if cap is not None and rata_spesa_16ter > cap:
            # le rate pregresse hanno priorità (già in detrazione); la quota corrente
            # viene ridotta a quel che resta del tetto
            disponibile = max(0.0, cap - pregresse_16ter)
            fattore_cap = disponibile / rata_spesa if rata_spesa > 0 else 1.0
            warnings.append(
                f"{p['nome']} {anno}: rata di spesa €{rata_spesa_16ter:,.0f} "
                f"(di cui €{pregresse_16ter:,.0f} da anni precedenti) oltre il tetto "
                f"art. 16-ter €{cap:,.0f} (reddito > €{settings.cap16ter_soglia:,.0f}): "
                f"detrazione ridotta."
            )

        rata_detrazione = rata_spesa * fattore_cap * aliquota
        detrazione_decennale = rata_detrazione * RATE_ANNUALI
        rata_breakdown = {
            "ristrutturazione": round(spesa_ristr_det / RATE_ANNUALI * fattore_cap * aliquota, 2),
            "ecobonus": round(spesa_eco_det / RATE_ANNUALI * fattore_cap * aliquota, 2),
            "mobili": round(spesa_mobili_det / RATE_ANNUALI * fattore_cap * aliquota, 2),
        }

        lorda = irpef_lorda(reddito, settings.scaglioni)
        detrazioni_totali = rata_detrazione + pregresse
        detrazioni_usate = min(detrazioni_totali, lorda)
        incapienza = detrazioni_totali - detrazioni_usate
        if incapienza > 0.005 and reddito > 0:
            warnings.append(
                f"{p['nome']} {anno}: €{incapienza:,.0f} di detrazioni perse per "
                f"incapienza IRPEF (lorda €{lorda:,.0f})."
            )
        netta = lorda - detrazioni_usate
        saldo = ritenute - netta  # >0 rimborso, <0 debito

        # recupero EFFETTIVO in 10 anni: ogni anno la rata è fruibile solo entro la
        # capienza IRPEF residua dopo le pregresse (stima a redditi costanti).
        # Con reddito non impostato (0) si mostra il teorico, come per il warning incapienza.
        if reddito > 0:
            rata_effettiva = min(rata_detrazione, max(0.0, lorda - pregresse))
        else:
            rata_effettiva = rata_detrazione

        # residuo fatturabile: vincolo unità immobiliare + vincoli personali
        residuo_unita_ristr = max(0.0, settings.tetto_ristrutturazione - tot_ristr)
        residuo_unita_mobili = max(0.0, settings.tetto_mobili - tot_mobili)
        headrooms = []
        if cap is not None:
            headrooms.append(max(0.0, cap - rata_spesa_16ter) * RATE_ANNUALI)
        if aliquota > 0:
            headrooms.append(max(0.0, lorda - detrazioni_usate) / aliquota * RATE_ANNUALI)
        headroom_personale = min(headrooms) if headrooms else float("inf")

        persone_out[pid] = {
            "nome": p["nome"],
            "reddito": reddito,
            "ritenute": ritenute,
            "spese": {
                "ristrutturazione": ristr_alloc[pid],
                "mobili": mobili_alloc[pid],
                "ecobonus": round(spesa_eco_det, 2),
                "non_detraibili": round(non_detraibili[pid], 2),
            },
            "rata_spesa": round(rata_spesa, 2),
            "pregresse_16ter_spesa": round(pregresse_16ter, 2),
            "rata_spesa_16ter": round(rata_spesa_16ter, 2),
            "cap_16ter": cap,
            "rata_detrazione": round(rata_detrazione, 2),
            "rata_detrazione_breakdown": rata_breakdown,
            "detrazione_decennale": round(detrazione_decennale, 2),
            "detrazione_decennale_effettiva": round(rata_effettiva * RATE_ANNUALI, 2),
            "detrazioni_pregresse": round(pregresse, 2),
            "irpef_lorda": lorda,
            "detrazioni_usate": round(detrazioni_usate, 2),
            "detrazioni_perse": round(incapienza, 2),
            "irpef_netta": round(netta, 2),
            "saldo_730": round(saldo, 2),
            "residuo_fatturabile": {
                "ristrutturazione": round(min(residuo_unita_ristr, headroom_personale), 2),
                "mobili": round(min(residuo_unita_mobili, headroom_personale), 2),
                "headroom_personale": None
                if headroom_personale == float("inf")
                else round(headroom_personale, 2),
            },
        }

    return {
        "anno": anno,
        "aliquota": aliquota,
        "solo_pagate": solo_pagate,
        "ristrutturazione": {
            "tetto": settings.tetto_ristrutturazione,
            "totale": round(tot_ristr, 2),
            "residuo": round(max(0.0, settings.tetto_ristrutturazione - tot_ristr), 2),
            "per_persona": ristr_alloc,
        },
        "mobili": {
            "tetto": settings.tetto_mobili,
            "totale": round(tot_mobili, 2),
            "residuo": round(max(0.0, settings.tetto_mobili - tot_mobili), 2),
            "per_persona": mobili_alloc,
        },
        "ecobonus": eco_alloc,
        "persone": persone_out,
        "warnings": warnings,
    }
