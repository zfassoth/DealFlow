# DealFlow V4.2 — Render / Postgres Build

This build is designed to run online on Render.

## What changed
- PostgreSQL instead of SQLite
- Persistent user accounts
- Persistent customer data
- Persistent login sessions stored in PostgreSQL
- Render health-check endpoint
- Optional OpenAI follow-up generation
- `render.yaml` included for Blueprint deployment

## Easiest deployment: Render Blueprint

1. Create a new GitHub repository named `dealflow`.
2. Upload every file/folder from this extracted package to the repository root.
3. In Render, choose **New + → Blueprint**.
4. Connect your GitHub account/repository.
5. Select the `dealflow` repository.
6. Render should detect `render.yaml`.
7. Create the Blueprint.

Render will create:
- a web service named `dealflow`
- a PostgreSQL database named `dealflow-db`
- a generated SESSION_SECRET
- a DATABASE_URL wired automatically

`OPENAI_API_KEY` is intentionally left blank. The app works without it using the built-in fallback follow-up generator.

## After deploy
Open the Render web-service URL and create your DealFlow account.

## Adding real AI later
In Render:
1. Open the DealFlow web service.
2. Go to Environment.
3. Add `OPENAI_API_KEY`.
4. Save/redeploy.

Never put an API key into GitHub or the browser code.

## Important
Only store customer/dealership information outside your dealership CRM if your dealership permits it.
