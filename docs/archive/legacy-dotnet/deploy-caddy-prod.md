# Production deployment with Caddy (Debian 13)

Fronts the app with [Caddy](https://caddyfiles.com/), which terminates TLS and
automatically obtains/renews a Let's Encrypt certificate. The app pulls its image from GHCR
instead of building on the server — `.github/workflows/release-image.yml` publishes
`ghcr.io/repasscloud/license-server-app` on every version tag.

## Files involved

- [`compose.prod.yaml`](../compose.prod.yaml) — postgres + app + caddy
- [`Caddyfile`](../Caddyfile) — reverse proxy + automatic HTTPS config
- [`.env.prod.example`](../.env.prod.example) — copy to `.env.prod` and fill in
- [`docker-up-prod.sh`](../docker-up-prod.sh) / [`docker-down-prod.sh`](../docker-down-prod.sh)

Only these five files (plus your signing keys) are needed on the server — cloning the
whole repo works too, but nothing else in it is required at runtime.

## First deploy

1. **DNS**: point the domain you're deploying to at this server's public IP (A/AAAA
   record), before starting Caddy — it needs to answer an HTTP-01 challenge on port 80 to
   issue the first certificate.
2. **Ports**: make sure 80/tcp and 443/tcp are open inbound (`ufw allow 80,443/tcp` or
   equivalent).
3. **Signing keys**: generate a production key pair (do not reuse this repo's PoC dev
   keys under `keys/`) and place `<keyId>.private.pem` / `<keyId>.public.pem` in a
   directory on the host, e.g. `/opt/license-server/keys`.
4. Copy the five files above onto the server (`git clone` this repo, or `scp` just those
   files).
5. `cp .env.prod.example .env.prod`, then replace every `replace-with-*` value: image
   tag (a released version, e.g. `v0.3.1`), domain, admin email, and all secrets/peppers.
   Keep `CUSTOMER_PORTAL_PUBLIC_BASE_URL` and `CADDY_DOMAIN` pointing at the same host.
6. `sh ./docker-up-prod.sh`

The script pulls the pinned image tag, brings up postgres → app → caddy in order (each
gated on the previous one's healthcheck), and prints the public HTTPS URL once healthy.

`ghcr.io/repasscloud/license-server-app` is a public package, so no `docker login` is
needed to pull it. If it's ever switched back to private, pulling will fail with a login
hint — authenticate first:

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
```

A classic PAT with `read:packages` is enough; it does not need `write:packages`.

## Rolling to a new release

1. Edit `IMAGE_TAG` in `.env.prod` to the new version tag.
2. `sh ./docker-up-prod.sh` again — it pulls the new tag and recreates only the `app`
   service (postgres and caddy are untouched, so there's no TLS cert re-issuance and no
   database downtime beyond the app container's own restart).

## Shutting down

`sh ./docker-down-prod.sh` stops the stack and keeps the postgres, Data Protection, and
Caddy (TLS cert/ACME state) volumes. Pass `REMOVE_VOLUMES=true` to also delete them —
this is destructive and discards the database, so treat it the same as any other
irreversible data-loss operation.

## Network layout

`compose.prod.yaml` splits containers across two Docker networks instead of one:

- `db` (`internal: true`) — postgres + app only. Neither container has any route out of
  this network, including to the internet.
- `edge` (normal bridge, pinned to `172.28.0.0/24`) — app + caddy. Gives the app outbound
  HTTPS for Stripe/MailerSend, and is the only network caddy joins — so caddy's published
  `80`/`443` ports are the sole path from the host into the stack. The app's own port is
  never published to the host.

`FORWARDED_HEADERS_KNOWN_NETWORK` in `.env.prod` trusts exactly the `edge` subnet, so the
app honors `X-Forwarded-*` headers only from that hop.

## What this doesn't cover

Signing keys are still a mounted PEM directory, matching the rest of this PoC — see the
README's "Security boundaries and production work" section for moving that behind a
KMS/HSM. Database backups, monitoring, and log shipping are also out of scope here; see
`docs/operator-runbook.md` for the broader production checklist.
