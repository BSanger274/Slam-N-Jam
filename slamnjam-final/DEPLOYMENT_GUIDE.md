# SLAM-N-JAM 2026 — Complete Setup & Deployment Guide

---

## What's in this package

```
slamnjam-final/
├── server.js              ← Node.js backend (ESPN API, bracket, scoring, admin)
├── package.json           ← Dependencies (express + cors only)
├── render.yaml            ← One-click Render.com config
├── data/
│   └── bracket_seed.json  ← Demo bracket shown before tournament starts
└── public/
    └── index.html         ← Full frontend (auto-served by backend)
```

---

## HOW LIVE UPDATES WORK

Once deployed, the server runs 24/7 and does this automatically:

| What | How Often | Source |
|------|-----------|--------|
| Player point totals | Every 60 seconds | ESPN Scoreboard API |
| Bracket results (wins/losses) | Every 90 seconds | ESPN Tournament API |
| Team standings | Recalculated instantly | Derived from above |

**During the tournament:** Everything updates automatically — no manual input needed.  
**Before/after the tournament:** Demo data is shown. The ESPN API only returns live data during actual tournament games.

---

## STEP 1 — Create a GitHub Account (if needed)
1. Go to **https://github.com** → Sign up (free)
2. Click **+** → **New repository**
3. Name it `slam-n-jam` → click **Create repository**

---

## STEP 2 — Upload the project files to GitHub

### Option A — GitHub Desktop (easiest, no command line)
1. Download **GitHub Desktop** from https://desktop.github.com
2. Open it → **File** → **Add Local Repository**
3. Browse to your `slamnjam-final` folder → **Add Repository**
4. Click **Publish repository** → choose your `slam-n-jam` repo → **Publish**

### Option B — Command line
```bash
cd path/to/slamnjam-final
git init
git add .
git commit -m "Initial deploy"
git remote add origin https://github.com/YOUR_USERNAME/slam-n-jam.git
git push -u origin main
```

---

## STEP 3 — Deploy on Render.com (Free)

1. Go to **https://render.com** → Sign up with your GitHub account

2. Click **New +** → **Web Service**

3. Click **Connect** next to your `slam-n-jam` repository

4. Fill in these settings:
   | Field | Value |
   |-------|-------|
   | Name | `slam-n-jam` (or anything you like) |
   | Region | US East (Ohio) — closest to you |
   | Runtime | **Node** |
   | Build Command | `npm install` |
   | Start Command | `node server.js` |
   | Instance Type | **Free** |

5. Scroll down to **Environment Variables** → click **Add Environment Variable**:
   | Key | Value |
   |-----|-------|
   | `ADMIN_PASSWORD` | `YourSecretPassword123` ← **CHANGE THIS** |

6. Click **Create Web Service**

7. Wait 2-3 minutes while it builds. You'll see logs like:
   ```
   🏀 SLAM-N-JAM server running → http://localhost:10000
   📡 Warming ESPN cache...
   ✅ Ready.
   ```

8. Your URL will be something like:
   **`https://slam-n-jam.onrender.com`**
   
   Share this link with all 18 team owners — that's all they need!

---

## STEP 4 — Add a Persistent Disk (IMPORTANT for Render free tier)

Render's free tier resets the filesystem on restart. To keep your rosters saved:

1. In your Render service → click **Disks** tab
2. Click **Add Disk**:
   | Field | Value |
   |-------|-------|
   | Name | `data` |
   | Mount Path | `/opt/render/project/src/data` |
   | Size | 1 GB (free) |
3. Click **Save** → your rosters will now survive server restarts

---

## STEP 5 — Upload Your Draft Roster

After your draft is complete:

1. Go to `https://your-site.onrender.com`
2. Click **Admin** in the nav → enter your password
3. Click **Roster Upload**
4. Paste your roster in this exact CSV format:

```
TeamName,PlayerName,School
Dream Team,Marcus Cooper,Duke
Dream Team,DeShawn Ellis,Kansas
Dream Team,Tyler Banks,Houston
Nutty Professor,Kevin Cross,Tennessee
Nutty Professor,Lance Moore,Michigan St.
...
```

**Tips:**
- One row per player
- School name must match how ESPN displays it (e.g. "Michigan St." not "MSU")
- Click **Download Template** to get a blank CSV to fill out during the draft
- You can re-upload at any time — it overwrites the previous roster

---

## STEP 6 — During the Tournament

**You don't need to do anything.** The bracket and scores update automatically.

The one time you may need to step in:

### If a player's points aren't showing up
ESPN displays player names differently than you might have typed them.
For example, ESPN might show `Cooper Flagg` but you typed `C. Flagg`.

**Fix:**
1. Admin → **Score Overrides**
2. Type the player name **exactly as in your roster**
3. Enter their current point total
4. Click **Set**

That override will be used until you remove it.

### If the bracket result is wrong or delayed
1. Admin → **Bracket Fix**
2. Find the Matchup ID from the bracket (shown in the data, e.g. `e15` for East Elite Eight)
3. Enter the scores and select the winner
4. Click **Save**

### Force a refresh right now
Admin panel → click **⚡ Force Refresh** to immediately re-poll ESPN instead of waiting 60 seconds.

---

## Sharing the Site

Just send everyone this link: **`https://your-site.onrender.com`**

- Anyone can view Dashboard, Teams, Players, Bracket, History
- Only you can access Admin (password protected)
- Works on phone and desktop
- No login required for viewers

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Site loads but shows no data | Upload your roster via Admin first |
| Bracket shows "demo data" | Normal — ESPN only has data during the tournament |
| Player points not updating | Use Score Override in Admin |
| Site says "Server offline" | Free Render tier sleeps after 15 min inactivity — first load takes ~30 sec to wake up |
| Roster disappeared after restart | Add a Persistent Disk (Step 4) |
| Forgot admin password | Go to Render dashboard → Environment Variables → change `ADMIN_PASSWORD` |

---

## Upgrading from Free to Always-On (Optional — $7/mo)

Render's free tier "sleeps" after 15 minutes of no traffic (first visitor waits ~30 sec).
To keep it always awake during tournament week:

1. Render dashboard → your service → **Upgrade** → select **Starter ($7/mo)**
2. Cancel after the tournament ends

---

*Questions? The admin panel has a Force Refresh button to manually trigger ESPN polling anytime.*
