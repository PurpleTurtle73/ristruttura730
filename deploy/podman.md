# Deploy con Podman + quadlet

L'esecuzione finale è sempre una **quadlet** systemd utente (rootless). L'immagine può
arrivare da una build locale (§1) o dal GitHub Container Registry (§2, consigliato:
la CI la pubblica da sola, §4).

Sostituisci `TUOUTENTE` con il tuo utente GitHub **in minuscolo** (i riferimenti OCI non
accettano maiuscole).

## 1. Build locale (senza registry)

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

Poi vai al §3 lasciando `Image=localhost/ristruttura730:latest` nella quadlet.

## 2. Immagine dal registry (ghcr.io)

**Immagine pubblica** (Package settings → Change visibility → Public — la visibilità del
package è separata da quella del repo!): nessuna autenticazione, basta

```bash
podman pull ghcr.io/TUOUTENTE/ristruttura730:latest
```

e puoi saltare al §3. I passi 2a/2b servono **solo per immagini private**.

### 2a. Crea il PAT (una tantum, solo immagine privata)

GitHub → Settings → Developer settings → **Personal access tokens (classic)** →
Generate new token (classic):

- scope: **solo `read:packages`** (il push lo fa la CI col token automatico; least
  privilege);
- expiration: una data (es. 90 giorni), non "no expiration";
- tipo *classic* obbligatorio: il Container Registry non accetta i fine-grained token.

### 2b. Login persistente sulla macchina che eseguirà il container

```bash
echo "ghp_xxx" | podman login ghcr.io -u TUOUTENTE --password-stdin \
  --authfile ~/.config/containers/auth.json
chmod 600 ~/.config/containers/auth.json
```

`--authfile` in `~/.config` è obbligatorio per la quadlet: il login di default finisce in
`XDG_RUNTIME_DIR`, che si svuota al riavvio, e systemd non riuscirebbe più a fare pull.

### 2c. Pull di verifica

```bash
podman pull ghcr.io/TUOUTENTE/ristruttura730:latest
```

## 3. Quadlet (avvio automatico con systemd utente)

```bash
mkdir -p ~/.local/share/ristruttura730 ~/.config/containers/systemd
cp deploy/ristruttura730.container ~/.config/containers/systemd/
```

Apri `~/.config/containers/systemd/ristruttura730.container` e sistema le righe in base
al tuo caso:

```ini
[Container]
# build locale:
#Image=localhost/ristruttura730:latest
# registry (immagine pubblica o privata):
Image=ghcr.io/TUOUTENTE/ristruttura730:latest
# SOLO per immagine privata: dove trovare le credenziali del §2b
Environment=REGISTRY_AUTH_FILE=%h/.config/containers/auth.json
# lato HOST del mapping (dentro al container uvicorn ascolta già su 0.0.0.0):
# - PublishPort=8730:8730          -> raggiungibile da LAN/VPN (default qui)
# - PublishPort=127.0.0.1:8730:8730 -> solo dal PC host
# L'app non ha autenticazione: esporla solo su reti fidate, mai su internet.
PublishPort=8730:8730
Volume=%h/.local/share/ristruttura730:/data:Z
# opzionali:
#Environment=BACKUP_INTERVAL_HOURS=24
#Environment=BACKUP_MAX_AGE_DAYS=5
```

Attiva:

```bash
systemctl --user daemon-reload
systemctl --user start ristruttura730
systemctl --user status ristruttura730     # verifica
journalctl --user -u ristruttura730 -f     # log
```

L'app è su `http://IP-DEL-SERVER:8730` (o `http://localhost:8730` dall'host). Se non
risponde dalla LAN, aprire la porta nel firewall del server — su Fedora/RHEL:

```bash
sudo firewall-cmd --add-port=8730/tcp --permanent && sudo firewall-cmd --reload
```

Per l'avvio al boot anche senza login:

```bash
loginctl enable-linger $USER
```

## 4. Build e push automatici (GitHub Actions)

Workflow incluso: `.github/workflows/container.yml`.

- **push su `main`** → job `test` (pytest) e, solo a test verdi, job `build` che pubblica
  `ghcr.io/TUOUTENTE/ristruttura730:latest`;
- **push di un tag `vX.Y.Z`** (es. `v1.0.0`) → stessa pipeline, ma pubblica
  `:X.Y.Z` **e** aggiorna `:latest`. Per rilasciare una versione:

  ```bash
  git tag v1.0.0
  git push origin v1.0.0
  ```

## 5. Dati e backup

- DB in `~/.local/share/ristruttura730/app.db` (volume `/data`).
- Snapshot automatici in `~/.local/share/ristruttura730/backups/`: uno ogni
  `BACKUP_INTERVAL_HOURS` ore (default 24), eliminati dopo `BACKUP_MAX_AGE_DAYS` giorni
  (default 5; manuali e prerestore mai toccati).
- Backup portabile completo: tab Configurazione → Backup → "Scarica backup JSON".

## 6. Aggiornamento

```bash
podman pull ghcr.io/TUOUTENTE/ristruttura730:latest   # o :X.Y.Z per bloccare la versione
systemctl --user restart ristruttura730
```

Automatico: con `AutoUpdate=registry` nella sezione `[Container]` della quadlet, il timer
di podman controlla il registry e riavvia il container quando l'immagine taggata cambia:

```bash
systemctl --user enable --now podman-auto-update.timer
```

Le migrazioni di schema sono automatiche all'avvio; anche il ripristino di uno snapshot
vecchio le riapplica da solo.
