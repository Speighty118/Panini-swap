# Panini World Cup 2026 Sticker Swap — SwapShelf

Backend API for the sticker matching/swapping platform.

## What's in here

```
api/            Express routes (auth, stickers, swaps, ratings)
jobs/           Scheduled matching job
db/             Database schema + sticker checklist importer
index.js        App entrypoint
```

## Local setup

1. Install dependencies:
   ```
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in real values.
3. Run the database setup script (see "Database setup" below).
4. Start the server:
   ```
   npm start
   ```

## Database setup

Run these against your Postgres database, in this order:

1. `db/setup_all.sql` — creates all tables, indexes, and the matching functions.
2. `db/seed_stickers.sql` — placeholder sticker data (980 rows with generic
   descriptions). Replace with the real checklist before going live:
   - Paste the official checklist text into a `.txt` file
   - Run `python3 db/import_checklist.py your_checklist.txt > db/seed_real.sql`
   - Run the resulting `seed_real.sql` against your database

## Deploying (Railway + Vercel)

See the full walkthrough in the project conversation, but in short:

1. Push this repo to GitHub.
2. On Railway: new project → add a Postgres database → add this repo as a
   second service → set environment variables from `.env.example` →
   run the SQL setup files against the Railway Postgres instance.
3. On Vercel: import the frontend repo/file → set the API URL environment
   variable to your Railway backend's public URL.
4. Set up the matching job (`jobs/run_matching.js`) to run on a schedule —
   Railway's cron feature, or any scheduler that can run `npm run match-job`.

## Environment variables

See `.env.example` for the full list with descriptions.
