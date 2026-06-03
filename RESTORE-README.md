# Davis Delivery Tracking — Restore Kit

This is the complete, working set of files for **tracking.davisdelivery.com**.

## What happened
Connecting the Netlify site to the GitHub repo (`DavisDelivery/DDS-Tracking`)
switched the site from "deploy these files directly" to "build from GitHub."
The repo was empty, so Netlify had nothing to publish and started serving its
default **"Page not found"** screen. That's why every tracking lookup said
*Shipment Not Found* — the page and its lookup functions were both gone.

Nothing was actually lost. These files restore everything.

## Folder layout (keep it exactly like this)
```
davisdeliverytracking/
├── netlify.toml                 ← site config + clean URLs
├── package.json                 ← function dependencies
├── public/
│   ├── index.html               ← the tracking page
│   ├── review.html              ← the /review page (for NuVizz emails)
│   └── admin.html               ← the /admin dashboard
└── netlify/
    └── functions/
        ├── track.js             ← shipment lookup (NuVizz)
        ├── doc.js               ← photo / POD fetch
        └── review.js            ← review capture + email alert
```

## The fix — two ways

### Option A (recommended, keeps your GitHub setup)
Put these files into the **DavisDelivery/DDS-Tracking** repo so the GitHub
build produces the correct site:

1. Go to https://github.com/DavisDelivery/DDS-Tracking
2. Click **Add file → Upload files**.
3. Drag in `netlify.toml`, `package.json`, the `public` folder, and the
   `netlify` folder (drag the folders themselves so the structure is kept).
4. Click **Commit changes**.

Netlify will see the commit, build automatically, and the site comes back —
and it stays fixed, because the repo now has the right files.

### Option B (disconnect GitHub, deploy files directly)
If you'd rather not use GitHub:

1. In Netlify → your site → **Site configuration → Build & deploy →
   Continuous deployment**, find **Repository** and click **Manage repository
   → Unlink**.
2. After that, the site uses direct deploys again (the way it worked before).

## Important settings already in place (don't need to redo)
These environment variables live on the Netlify site and survive everything
above — you do **not** need to re-enter them:
`NUVIZZ_DAVIS_USER`, `NUVIZZ_DAVIS_PASS`, `NUVIZZ_ULINE_USER`,
`NUVIZZ_ULINE_PASS`, `RESEND_API_KEY`, `REVIEW_EMAIL`, `DASHBOARD_KEY`.

## Quick test after it's back
- Tracking: https://tracking.davisdelivery.com/?pro=007107386
- Review page: https://tracking.davisdelivery.com/review?pro=007107386
- Admin dashboard: https://tracking.davisdelivery.com/admin  (password: davis2026)
