# Hosted demo on Nebius

The hosted demo runs Gnosis on a small Nebius VM so anyone with an invite link can try it from a phone or browser. It has the brain (Nemotron on Nebius Token Factory), the chat and approvals app, tasks, reminders, memory, saved skills and the coding agent. Desktop control, voice and Android control need the Windows laptop, so they aren't part of it.

## What you need

- A Nebius AI Cloud account with a Token Factory API key.
- A CPU-only VM is enough, because the models run on Token Factory: 2 vCPUs, 8 GB RAM, Ubuntu 24.04, a public IP address, and ports 22, 80 and 443 open.

## Set it up

SSH into the VM, then:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/vkvr-2007/gnosis && cd gnosis
cp deploy/.env.example deploy/.env
nano deploy/.env
```

In `deploy/.env`, set `NEBIUS_API_KEY`, and set `GNOSIS_DOMAIN` to the VM's public IP with dashes and `.sslip.io` on the end (for `203.0.113.7`, that's `203-0-113-7.sslip.io`). Caddy gets a free HTTPS certificate for that name, which the phone app needs for notifications and the microphone. `GH_TOKEN` and `VERCEL_TOKEN` are optional; without them the coding agent still builds and runs projects but can't publish them.

Start it:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

## Invite someone

Each person needs their own link, which works once and expires after 5 minutes:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec gnosis gnosis invite
```

It prints a QR code and the link. Opening it pairs that browser, and it stays paired. Nobody can use the demo without a link: every request is checked for a paired device's token, and the laptop dashboard isn't served to the internet.

## How it's kept safe

- **Approvals still apply.** Anything outward-facing (pushing to GitHub, deploying) asks on the phone app first, and so does every command the coding agent runs, because here it runs in the same container as Gnosis.
- **Code can't read the keys.** Commands the coding agent runs get a minimal environment with no API keys. The Gnosis process also marks itself non-dumpable, so code running as the same user can't read its environment or memory through `/proc`.
- **Only Caddy is exposed.** Gnosis listens inside the compose network; ports 80 and 443 go to Caddy.

## Day to day

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f gnosis   # Watch it
git pull && docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build   # Update
docker compose -f deploy/docker-compose.yml --env-file deploy/.env down   # Stop (data is kept in a volume)
```
