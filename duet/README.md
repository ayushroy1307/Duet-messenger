# Duet

A two-party, end-to-end encrypted messenger, built from `duet-app-spec.md`.
Zero npm dependencies: Node >= 20 for the server, plain ES modules + WebCrypto in the browser.
The supplied image is used for **every** icon (app icon, favicon, PWA/maskable icons, notification icons, and all in-app button icons).

## Run

    npm start                 # http://localhost:3000   (dev: login codes are echoed on screen)
    npm test                  # 41 tests: crypto rules (spec §7), vault, real-server e2e, and Supabase persistence (emulated)

Sign-in: by default people register and sign in with **phone number + password**: no SMS provider, no codes. The number is only a sign-in name (it is not verified), so set `SIGNUP_CODE` on any public server and share that code only with the person you want to chat with. Passwords are stored as scrypt hashes.
Optional: `AUTH_MODE=otp` switches to 6-digit SMS codes (needs `TWILIO_*` or `SMS_WEBHOOK_URL`; in dev the code is echoed on screen unless `DEV_SHOW_OTP=0`).

Production: `NODE_ENV=production COOKIE_SECURE=1 SIGNUP_CODE=... PUBLIC_URL=https://your.host npm start` (serve behind HTTPS).
Other env: `PORT`, `SESSION_SECRET`, `DATA_DIR`, `DIAG_TOKEN` (enables `GET /api/diag?token=`), `VAPID_SUBJECT`.

## Deploy: Supabase + Render
1. **Supabase** → New project. SQL Editor → paste `supabase/schema.sql` → Run (creates 11 tables, the two message indexes, and turns Row Level Security on with no public policies).
   Project Settings → API: copy the **Project URL** and the **service_role** key (secret: server only, never in the browser or git).
   The private media bucket (`duet-media`) is created automatically on first boot.
2. **Render** → New → Blueprint → select this repo (it reads `render.yaml`). Fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PUBLIC_URL` and `SIGNUP_CODE` (make one up). No SMS provider is needed: people sign in with phone number + password.
3. Open `https://<your-service>.onrender.com/api/health`: expect `"store":"supabase-postgres"`, `"media":"supabase-storage"`, `"auth":"password"` and an empty `warnings` list.
4. Run **exactly one instance** (realtime and rate limits are in memory) and use a paid Render plan: the free plan sleeps and drops live connections.
5. Android: set the host in `android/twa-manifest.json` to your Render domain, then `npx @bubblewrap/cli init --manifest=https://<domain>/manifest.webmanifest`.

How storage works: the server keeps a working set in memory and writes changes to Supabase in the background (about 300 ms later, retried with backoff; a SIGTERM during a Render deploy flushes first). All messages are loaded at boot, which is fine for a two-person app but not for millions of rows.

## Layout
- `server.js` relay: auth/OTP, sessions, invites, prekey registry (merge, never overwrite), messages (idempotent on clientId), media blobs, SSE, opaque web push, health, diagnostics sink.
- `public/js/crypto.js` X3DH + Double Ratchet. `engine.js` session lifecycle implementing spec §7.1–7.13. `vaultcore.js` master key + PIN / biometric(PRF) / recovery wrapping.
- `public/js/app.js` auth + vault phases; `main.js` chat list, chat, sheets. `sw.js` offline shell + push.
- `android/twa-manifest.json` config for a thin Android wrapper (`npx @bubblewrap/cli init --manifest=...`) around the deployed PWA.

## Deliberate deviations from the spec (WebCrypto only, no dependencies)
- Vault PIN KDF is PBKDF2-SHA256 (600k iterations) instead of scrypt; message AEAD is AES-256-GCM instead of XChaCha20-Poly1305; identity uses separate Ed25519 and X25519 keys instead of converting one to the other.
- The recovery code resets the PIN on this device. Message history is local-only (spec §10: no cloud export), so on a new device you start fresh and your contact re-pairs automatically.
- Postgres tables are `id + jsonb` (messages also have real columns and indexes) behind a write-behind cache, not a normalised relational model. Dev uses a JSON file.
- Not verified here: the Supabase and Twilio code was tested against local emulators only (no network access in this build environment). Also unverified: biometric (WebAuthn PRF) unlock, web push delivery, and the Android build.
