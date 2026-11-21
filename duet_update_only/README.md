# Duet

End-to-end encrypted two-person messenger. Node 22, no npm dependencies, no build step.

## Deploy (Render + Supabase)
1. Run `supabase/schema.sql` in the Supabase SQL Editor.
2. Push this repo to GitHub (files at the repo root: `server/`, `public/`, `package.json`, `render.yaml`).
3. Render -> New -> Blueprint -> pick the repo. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_ORIGIN` (your https://....onrender.com URL).

## Updating
Commit changed files to the connected branch. Render redeploys automatically (autoDeploy).
The service-worker cache version is derived from the build hash on the server, so users get the new
version on their next visit with no manual version bump.
After a deploy, check `https://YOUR-APP.onrender.com/api/health`.
