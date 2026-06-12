# Deploy con Podman + quadlet

Tre strade, dalla più semplice: build locale, immagine da registry (GitHub Container
Registry), build automatica con GitHub Actions. In tutti i casi l'esecuzione finale è una
**quadlet** systemd utente (rootless).

## 1. Build locale

Dalla radice del repository:

```bash
podman build -t ristruttura730 -f deploy/Containerfile .
```

Prova rapida (CTRL+C per fermare):

```bash
mkdir -p ~/.local/share/ristruttura730
podman run --rm -p 127.0.0.1:8730:8730 \
  -v ~/.local/share/ristruttura730:/data:Z ristruttura730
# -> http://localhost:8730
```

## 2. Immagine da registry (ghcr.io)

Per non ricostruire l'immagine su ogni macchina, pubblicala sul GitHub Container Registry
del tuo fork (sostituisci `TUOUTENTE` ovunque):

```bash
# login con un Personal Access Token con scope write:packages
echo "$GITHUB_TOKEN" | podman login ghcr.io -u TUOUTENTE --password-stdin

podman build -t ghcr.io/TUOUTENTE/ristruttura730:latest -f deploy/Containerfile .
podman push ghcr.io/TUOUTENTE/ristruttura730:latest
```

Sulle altre macchine basta `podman pull ghcr.io/TUOUTENTE/ristruttura730:latest`.
Per rendere l'immagine scaricabile senza login: GitHub → Packages → ristruttura730 →
Package settings → Change visibility → Public.

## 3. Build automatica con GitHub Actions

Il workflow è già incluso nel repository: `.github/workflows/container.yml`. Ad ogni push
su `main` (o lancio manuale dal tab Actions, `workflow_dispatch`):

1. job **test**: installa le dipendenze ed esegue `pytest tests/`;
2. job **build** (`needs: test`, parte solo a test verdi): build da `deploy/Containerfile`
   e push su `ghcr.io/TUOUTENTE/ristruttura730` con tag `latest` + SHA del commit.

Push consecutivi annullano la build precedente in corso (`concurrency`). L'immagine
quindi viene pubblicata **solo se i test passano**.

### Repo privato

Il workflow funziona identico (il `GITHUB_TOKEN` automatico basta anche per i repo
privati). Differenze:

- free tier: 2.000 minuti Actions/mese (questa build ne usa ~2-3) e 500 MB di storage per
  i package privati — eliminare ogni tanto le versioni SHA vecchie da Package → Settings;
- l'immagine eredita la visibilità del repo (privata): per il pull dalle proprie macchine
  serve un PAT classic con scope `read:packages`:

  ```bash
  echo "ghp_xxx" | podman login ghcr.io -u TUOUTENTE --password-stdin \
    --authfile ~/.config/containers/auth.json
  ```

  L'`--authfile` persistente è necessario per la quadlet (il login di default vive in
  `XDG_RUNTIME_DIR`, che si svuota al riavvio). Nella quadlet aggiungere:

  ```ini
  Environment=REGISTRY_AUTH_FILE=%h/.config/containers/auth.json
  ```

## 4. Quadlet (avvio automatico con systemd utente)

```bash
mkdir -p ~/.local/share/ristruttura730 ~/.config/containers/systemd
cp deploy/ristruttura730.container ~/.config/containers/systemd/
```

Se usi il registry, nel file `.container` sostituisci la riga `Image=` con:

```ini
Image=ghcr.io/TUOUTENTE/ristruttura730:latest
```

Poi:

```bash
systemctl --user daemon-reload
systemctl --user start ristruttura730
systemctl --user status ristruttura730     # verifica
journalctl --user -u ristruttura730 -f     # log
```

L'app è su <http://localhost:8730>. Per partire al boot anche senza sessione aperta:

```bash
loginctl enable-linger $USER
```

## Dati e backup

- Il DB persiste in `~/.local/share/ristruttura730/app.db` (volume `/data`).
- Gli snapshot automatici sono in `~/.local/share/ristruttura730/backups/`, uno ogni
  `BACKUP_INTERVAL_HOURS` ore (default 24), ruotati dopo `BACKUP_MAX_AGE_DAYS` giorni
  (default 5). Le variabili si impostano nella quadlet con righe `Environment=`.
- Backup completo portabile: tab Configurazione → Backup → "Scarica backup JSON".

## Aggiornamento

```bash
podman pull ghcr.io/TUOUTENTE/ristruttura730:latest   # oppure: podman build ...
systemctl --user restart ristruttura730
```

Le migrazioni di schema sono automatiche all'avvio; il ripristino di uno snapshot vecchio
riapplica le migrazioni da solo.
