# Versione portable per Windows

Obiettivo: una cartella autonoma (anche su chiavetta USB), **nessuna installazione, nessun
privilegio amministratore**: doppio click su `avvia.bat` e si apre il browser sull'app.

> **Build automatica**: il workflow `.github/workflows/windows-portable.yml` produce lo
> zip da solo. Ad ogni tag `vX.Y.Z` crea la release GitHub e ci allega
> `ristruttura730-portable-win64.zip`; con "Run workflow" (workflow_dispatch) lo trovi tra
> gli artifact della run. La procedura manuale qui sotto resta valida se vuoi farlo a mano.

Si usa il **Python embeddable** ufficiale: una distribuzione zip di Python che non tocca il
registro di Windows e non richiede setup.

## Struttura finale

```
ristruttura730\
├── py\            python embeddable + dipendenze (fastapi, uvicorn)
├── app\           codice + frontend (dal repository)
├── data\          creata al primo avvio: app.db + backups\
└── avvia.bat
```

## Preparazione (una tantum, serve internet)

1. **Scarica Python embeddable**: da <https://www.python.org/downloads/windows/> prendi
   "Windows embeddable package (64-bit)" di Python 3.12 o successivo. Estrai lo zip in
   `ristruttura730\py\`.

2. **Abilita pip** (l'embeddable ne è privo):
   - apri `py\python312._pth` (il numero varia con la versione) con un editor di testo e
     togli il `#` davanti alla riga `import site`;
   - scarica <https://bootstrap.pypa.io/get-pip.py> dentro `py\`;
   - da Prompt dei comandi nella cartella `ristruttura730`:
     ```bat
     py\python.exe py\get-pip.py
     ```

3. **Installa le dipendenze** (solo runtime, pytest non serve):
   ```bat
   py\python.exe -m pip install fastapi "uvicorn[standard]"
   ```

4. **Copia la cartella `app\`** del repository (con tutto `app\static\`, incluso
   `static\vendor\`: Chart.js e Pico.css sono già locali, da qui in poi **non serve più
   internet**) accanto a `py\`.

5. **Crea `avvia.bat`** nella radice:
   ```bat
   @echo off
   cd /d %~dp0
   set DB_PATH=data\app.db
   start "" http://localhost:8730
   py\python.exe -m uvicorn app.main:app --port 8730
   ```

## Uso

- Doppio click su `avvia.bat`: si apre il browser su `http://localhost:8730` (alla prima
  apertura aggiorna la pagina se il server non era ancora pronto).
- Per chiudere: chiudi la finestra del terminale.
- Tutti i dati restano in `data\` (database + snapshot automatici): per il backup o per
  spostare l'app basta copiare l'intera cartella `ristruttura730\`.

## Note

- Se Windows SmartScreen blocca `avvia.bat`: "Ulteriori informazioni" → "Esegui comunque".
- Se la porta 8730 è occupata, cambia il numero sia nel `.bat` (riga `start` e riga
  `uvicorn`) sia nell'URL.
- Aggiornamento dell'app: sostituisci la sola cartella `app\` con la versione nuova; `data\`
  non si tocca (le migrazioni di schema sono automatiche al primo avvio).
