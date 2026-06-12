# Roadmap

Idee di miglioramento, da aggiornare nel tempo.

Legenda: `[ ]` da fare · `[x]` fatto · `[-]` scartato.

## Fiscale / calcoli

## Funzionalità
- [ ] Persone dinamiche (1..N invece di 2 fisse): CRUD in Configurazione con guardia su eliminazione (spese/pregresse referenziate), split "50_50" reinterpretato come "in parti uguali" (`importo/N` — oggi divide per 2 fisso: con N≠2 sarebbe errato), etichette UI. Eventuale v2: split percentuale per spesa (es. 60/25/15)

## UI / UX

## Tecnico
- [ ] Auth centralizzata per tutti i tool self-hosted: reverse proxy unico (Caddy/Traefik) + forward-auth (Authelia) in quadlet; le app tornano su 127.0.0.1 e solo il proxy esce su LAN/VPN; login unico, eventuale 2FA, identità via header Remote-User
