# Ristruttura730

Web app self-hosted per tracciare le spese di ristrutturazione di un immobile in comproprietà
(due persone) e calcolare cosa portare in detrazione nel 730: **bonus ristrutturazione**,
**ecobonus**, **bonus mobili**, con simulazione della liquidazione IRPEF (rimborso/debito
stimato rispetto alle ritenute del sostituto d'imposta).

Pensata per uso personale: niente autenticazione, un solo container, database SQLite su file.

## Funzionalità

- **Spese**: inserimento rapido da tastiera (Enter aggiunge, i campi ripetitivi restano
  compilati), aggiunta multipla a griglia, modifica in linea di ogni cella, duplicazione con
  un click, ricerca testuale live, ordinamento per colonna, filtri.
- **Fornitori**: ognuno associato a un tipo di bonus (e categoria d'intervento per l'ecobonus);
  il bonus è sovrascrivibile sulla singola spesa.
- **Flag per spesa**: pagata/da pagare (per le previsioni) e detraibile/no (bonifico parlante
  sì/no) come etichette cliccabili.
- **Limiti applicati** (default 2025/2026, tutti modificabili per anno fiscale):
  - bonus ristrutturazione: 50% abitazione principale / 36% altre, max **96.000 € per unità
    immobiliare/anno** (il tetto è dell'immobile: i comproprietari se lo dividono in base a
    chi paga col bonifico parlante);
  - ecobonus: massimale di **detrazione** per categoria d'intervento (infissi, caldaie…);
  - bonus mobili: max 5.000 €/anno per unità immobiliare;
  - detrazione ripartita in 10 rate annuali;
  - tetto spese detraibili **art. 16-ter TUIR** per redditi > 75.000 € (coefficiente familiare);
  - **capienza IRPEF**: la rata che supera l'imposta lorda è persa (warning).
- **Dashboard**: card per bonus (spesa totale, detraibile, residuo, recupero %), totali
  complessivi, riepilogo per persona (limiti annui, fatturato/fatturabile per bonus, recupero
  decennale, saldo 730), ciambella per fornitore, scadenzario "da pagare" a 3 mesi, andamento
  mensile cumulato. Toggle globale consuntivo (solo pagate) / previsione.
- **730**: simulazione liquidazione per persona (IRPEF a scaglioni → detrazioni, incluse le
  rate di anni precedenti gestite come voci → rimborso/debito), export CSV per il CAF.
- **Anni precedenti**: detrazioni in corso di dilazione come voci (descrizione, importo, anno,
  rate, aliquota), con conteggio automatico nel tetto 16-ter per le spese dal 2025.
- **Multi-anno**: ogni anno fiscale ha i suoi tetti, aliquote, scaglioni IRPEF e redditi.
- **Backup**: snapshot automatici del DB (rotazione per età), manuali, ripristino con snapshot
  di sicurezza, export/import JSON completo.
- **Warning** in overlay quando un tetto viene superato. Dark mode. Salvataggio automatico.

> ⚠️ **Disclaimer**: i valori fiscali precaricati sono indicativi e possono cambiare con le
> leggi di bilancio. Lo strumento non sostituisce CAF o commercialista: verificare sempre
> aliquote, massimali e requisiti con un professionista.

## Avvio rapido (sviluppo)

Richiede Python 3.12+.

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 8730
# -> http://localhost:8730
```

Il database viene creato in `data/app.db` (override con env `DB_PATH`), i backup in
`data/backups/` (override con `BACKUP_DIR`).

### Variabili d'ambiente

| Variabile | Default | Significato |
|---|---|---|
| `DB_PATH` | `data/app.db` | percorso del database SQLite |
| `BACKUP_DIR` | `<dir db>/backups` | cartella degli snapshot |
| `BACKUP_INTERVAL_HOURS` | `24` | frequenza backup automatici (`0` = disattivati) |
| `BACKUP_MAX_AGE_DAYS` | `5` | rotazione: età massima degli snapshot automatici |

### Test

```bash
.venv/bin/python -m pytest tests/
```

Il motore di calcolo (`app/calc.py`) è a funzioni pure e completamente testato: tetti,
ripartizioni, 16-ter, incapienza, rate pregresse.

## Deploy

- **Podman / container + quadlet systemd**: [deploy/podman.md](deploy/podman.md)
- **Windows portable** (chiavetta, zero installazione): [deploy/windows-portable.md](deploy/windows-portable.md)

## Struttura del progetto

```
app/
  main.py     # API REST (FastAPI) + serving frontend, scheduler backup
  db.py       # SQLite (stdlib), schema, migrazioni additive, backup/restore
  calc.py     # motore di calcolo fiscale: funzioni pure, testabili
  static/     # frontend vanilla JS single-page (Chart.js + Pico.css vendorizzati)
tests/        # pytest su calc.py e db.py
deploy/       # Containerfile, quadlet, guide di deploy
PLAN.md       # piano completo per ricostruire l'applicazione da zero
```

Nessuna dipendenza frontend da CDN: Chart.js e Pico.css sono vendorizzati in
`app/static/vendor/`, l'app funziona offline.
