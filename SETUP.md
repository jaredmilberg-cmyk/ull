[SETUP.md](https://github.com/user-attachments/files/28480517/SETUP.md)
# Urban Leaf Webhook — Production Setup

## What changed
Sessions are now stored in a SQLite database (`sessions.db`) instead of
in-memory. Conversations survive server restarts and deploys automatically.

---

## Local setup

```bash
npm install          # installs express + better-sqlite3
npm start            # starts the server on port 3000
```

The file `sessions.db` will be created automatically next to `index.js`
on first run. You do not need to create it manually.

---

## Render deployment

### 1. Add the new dependency
`package.json` already lists `better-sqlite3`. Just push to GitHub —
Render will run `npm install` automatically on deploy.

### 2. Add a Persistent Disk (REQUIRED — free tier available)
Without this, `sessions.db` is wiped on every deploy.

1. Render Dashboard → your Web Service → **Disks**
2. Click **Add Disk**
3. Set mount path: `/var/data`
4. Size: `1 GB` (free tier)
5. Save

### 3. Add the DB_PATH environment variable
1. Render Dashboard → your service → **Environment**
2. Add:
   - Key: `DB_PATH`
   - Value: `/var/data/sessions.db`
3. Save & redeploy

That's it. Sessions will now survive every deploy and restart.

---

## Environment variables

| Variable            | Required | Default                      | Notes                                      |
|---------------------|----------|------------------------------|--------------------------------------------|
| `DB_PATH`           | Yes*     | `./sessions.db`              | *Required on Render for persistence        |
| `META_VERIFY_TOKEN` | Yes      | `urban_leaf_verify_token`    | Set this to a secret value in production   |
| `PORT`              | No       | `3000`                       | Render sets this automatically             |

---

## Verifying it works

Hit the health endpoint after deploy:

```
GET https://your-app.onrender.com/health
```

Response:
```json
{ "status": "ok", "totalSessions": 0, "dbPath": "/var/data/sessions.db" }
```

`totalSessions` will increment as users interact with the bot.

---

## Future upgrade: Redis

If you ever need multiple server instances (horizontal scaling), swap
`better-sqlite3` for `ioredis`. The session helper functions (`getSession`,
`saveSession`) are cleanly separated, so the rest of the code stays the same.
