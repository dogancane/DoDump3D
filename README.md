# DoDump 3D

Full 3D discrete element (DEM) simulator for rock dumping through a moonpool bucket fall pipe or an inclined side pipe. It predicts where and how often the pipe blocks for a given pipe geometry, rock grade, feed and vessel motion.

DoDump 3D is the 3D companion to the DoDump 2D app. Both use the same input set, rock grade library and shared modules in `js/`.

> Internal engineering tool. The page carries `noindex` tags and a `robots.txt`, so search engines and AI crawlers are told not to list it. See [Keeping it out of search engines](#keeping-it-out-of-search-engines).

## What it does

- **Simulate tab:** one run with a live 3D view, charts, a blockage status (green, yellow, orange, red) and event log.
- **Probability tab:**
  - many runs (seeds) per case, headless in background workers
  - result matrix of rock grade against a varied parameter (bucket ID, insertion, flow, belt speed, roll, tilt, dry height, friction and shape sensitivity)
  - blockage probability with 95 % intervals and blockage rate per 1000 t
  - where it blocks, which stones formed the dome, and wall impacts
- **Validation benchmark:** 3D silo clogging with identical spheres against Zuriguel et al. (2005).
- **Results tab:** summary of each finished run and a comparison table. Kept in the browser.
- **Diagnostics tab:** mass and count balance, contact overlap, time step, wall impacts and the water column state.
- **Method tab:** model description and assumptions. Behind the admin login, the same as the 2D app.

## Model summary

| Part | 3D model |
|---|---|
| Stones | Mass from the grade (measured masses or standard envelope); Zingg shape classes; superellipsoid body in L x B x T with exponent set by the volume factor; up to 24 inscribed contact spheres; 6 degrees of freedom |
| Contacts | Linear spring-dashpot normal force, Coulomb friction with a 3D tangential spring, rolling resistance; wall stiffness from the bucket material E* |
| Walls | Bucket cones, wall thickness, lips and insertion ledges revolved about the pipe axis; feed chute or funnel; restart gate |
| Water | Coupled 1D water column along the whole string: entrained flow, joint leakage, free surface in the moonpool, Di Felice hindered drag, pressure gradient, added mass |
| Feed | Drop at rest, or conveyor discharge (belt speed, direction, drop, stream width, scatter, spin) |
| Vessel | Regular roll, pitch and heave as apparent gravity in the pipe frame |
| Pipe shape | Vertical, straight tilt, top angle plus change per joint, or static chain in current with the FP ROV |
| Numerics | Semi-implicit Euler, quaternions with gyroscopic term, time step from the rotational effective mass; precision presets Standard, High (default), Very high |

The model has not been calibrated against rock tests. Use it to compare cases (pipe size A against B, grade X against Y) with the same seeds, duration and precision. Absolute probabilities depend on rock-to-HDPE friction, the volume factor and the shape class mix of the actual rock. See [`docs/VALIDATION.md`](docs/VALIDATION.md).

## Deploy on GitHub Pages

The app is static HTML and JavaScript. It has no build step and no server code.

### Option A: as a folder in the DoDump 2D repository (recommended)

1. Copy this whole folder into the 2D repository as `3d/`:
   ```
   your-dodump-repo/
     index.html        (2D app)
     js/               (2D modules)
     3d/
       index.html      (this app)
       js/
       js3d/
       robots.txt
   ```
2. Commit and push. The app opens at `https://<user>.github.io/<repo>/3d/`.
3. "Load inputs from the 2D page" on the Simulate tab now works, because both pages share one origin and therefore one browser storage.

`3d/js/` is a copy of the 2D `js/` folder at the time of packaging, so the 3D app keeps working even if the 2D modules change later. To share one copy instead, delete `3d/js/` and change `js/` to `../js/` in `3d/index.html` and in `3d/js3d/worker3d.js`. Do this only if the 2D modules stay compatible.

### Option B: as its own repository

1. Create a repository, for example `dodump-3d`, and push the contents of this folder to its root.
2. Go to Settings, then Pages. Under "Build and deployment", set the source to "Deploy from a branch", choose branch `main` and folder `/ (root)`, then press Save.
3. The app opens at `https://<user>.github.io/dodump-3d/` after about a minute.

"Load inputs from the 2D page" still works when both repositories are published under the same `<user>.github.io`, because browser storage is shared per host, not per path. It does not work if one of them uses a custom domain.

### Commands

```bash
git init
git add .
git commit -m "DoDump 3D lab 0.3"
git branch -M main
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

### Local test

The workers need the page to be served over HTTP; opening `index.html` as a file does not work.

```bash
python3 -m http.server 8000
# open http://localhost:8000/
```

## Keeping it out of search engines

- **`<meta name="robots" content="noindex, nofollow, ...">`** in `index.html` is the control that keeps the page out of Google, Bing and others. It works on any GitHub Pages URL. Keep it.
- **`robots.txt`** asks all crawlers, including AI crawlers (GPTBot, ClaudeBot, Google-Extended, CCBot, PerplexityBot and others), not to crawl. Crawlers only read it at the root of a host. It takes effect for a user site (`<user>.github.io`) or a custom domain. For a project page (`<user>.github.io/<repo>/`) it is ignored, and the meta tag does the work.
- **The 2D app:** to keep it out of search results too, add the same meta line to the `<head>` of the 2D `index.html`:
  ```html
  <meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">
  ```
  If you place the files in `3d/`, also copy `robots.txt` to the repository root.
- **Already indexed?** If the 2D page has been online without the tag, it can take a few weeks to drop out. To speed this up, verify the site in Google Search Console and use Removals.

These tags stop listing in search. They do not make the app private:
- A public repository shows all code to anyone who looks.
- Anyone with the link can open the page.

For real access control, keep the repository private. GitHub Pages from a private repository needs GitHub Pro, Team or Enterprise. Enterprise can also restrict the Pages site to organization members.

The admin login for the Method tab is a client-side lock (PBKDF2-SHA256 hash in `js/admin-config.js`). It hides the tab in the interface. It does not protect the content, which is in the page source.

## Files

| Path | Content |
|---|---|
| `index.html` | Page, styles, Method text |
| `js/` | Shared with the 2D app: grades, materials, string, water column, checks, charts, detection, results, statistics, admin lock |
| `js3d/shapes3d.js` | 3D stone generator: superellipsoid body and inscribed sphere fill |
| `js3d/particles3d.js` | Stone factory and sample statistics |
| `js3d/geometry3d.js` | Revolved wall profiles, gravity direction along the pipe |
| `js3d/config3d.js` | 3D defaults, precision presets, derived values |
| `js3d/physics3d.js` | 3D DEM engine, feed, vessel motion, wall impact log |
| `js3d/detection3d.js` | Dome and blockage detection (12 wall sectors) |
| `js3d/render3d.js` | WebGL view (three.js r128 from cdnjs) |
| `js3d/ui3d.js` | Simulate, Results and Diagnostics tabs |
| `js3d/prob3d.js` | Probability tab |
| `js3d/study3d.js`, `runner3d.js`, `worker3d.js` | Headless runs in Web Workers |
| `js3d/bench3d.js` | 3D silo clogging benchmark |
| `js3d/extra3d.js` | Wall impacts and water entry statistics per run |
| `robots.txt`, `.nojekyll`, `.gitignore` | Crawler rules, GitHub Pages settings, git ignore list |

## Browser storage

The app keeps the following in the browser's local storage, per site:
- inputs: `fallpipe3d.cfg.v1`
- runs: `fallpipe3d.runs.v1`
- last study: `fallpipe3d.study.v1`
- sphere fill cache: `fallpipe3d.clumps.v4`

It reads the 2D inputs (`fallpipe.cfg.v2`) and grade library (`fallpipe.grades.v2`). Nothing is sent to a server.

## External resources

- three.js r128 from `cdnjs.cloudflare.com`, for the 3D view only. Without it the simulation still runs, and the view shows a notice.
- Fonts from Google Fonts, with system fallbacks.

## Licence

No licence file is included, so all rights are reserved by default. Add a licence before sharing the code for reuse.
