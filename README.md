# TwinFlow — Digital Thread for Industrialized Construction

[![check](https://github.com/gabritexabc/twinflow/actions/workflows/check.yml/badge.svg)](https://github.com/gabritexabc/twinflow/actions/workflows/check.yml)

*(formerly IFCFlow — renamed because the app is really about giving every prefabricated
component a digital twin that flows from the BIM model through the factory to the site.)*

Web app that connects the **BIM model → off-site factory → JIT logistics → site assembly** flow,
inspired by the industrialized construction process (CREE-type systems) used at projects like the
Coimbra Student Residence: façade panels, hybrid slabs, parapets (platibandas) and edge beams
(vigas de bordadura) produced off-site and assembled just-in-time on a constrained urban site.

## What it does

1. **Multi-project dashboard** — manage a portfolio of projects. Each imported IFC becomes a
   project card with its own KPIs (elements, requests, installed %, progress bar); the top-right
   selector switches the active project. Portfolio-level KPIs aggregate everything.
2. **Read IFC** — open any `.ifc` file (IFC2x3 / IFC4) directly in the browser
   ([web-ifc](https://github.com/ThatOpen/engine_web-ifc) WASM parser + three.js 3D viewer).
   Click any element to inspect its GUID, tag and quantities.
3. **Extract quantities (QTO)** — automatic takeoff grouped by typology
   (walls, slabs, beams, columns, panels…): count, volume (m³), area (m²), length (m),
   read from the model's `IfcElementQuantity` sets.
4. **Request off-site production** — select typologies and quantities → create a
   **Production Request** addressed to a factory, with a JIT need-by date and notes
   (assembly sequence, crane constraints). Printable as PDF, emailable via SMTP.
5. **Administer the process between all parties** — each request moves through a
   role-gated workflow with a full event timeline (audit trail) and non-conformity log:

   | Status | Who acts |
   |---|---|
   | Draft → Submitted | Site Preparation / GC |
   | Submitted → Accepted / Rejected | Factory |
   | Accepted → In Production → Ready (LOD400) | Factory |
   | Ready → In Transit → Delivered | Logistics |
   | Delivered → Installed | Site Assembly Team |

   The **Dashboard** computes the KPIs from the report methodology: elements per status
   (scoped to the selected project), installed per active day (productivity),
   delivered→installed cycle time, non-conformity rate, and **PPC — Percent Plan
   Complete** (Last Planner System): the share of requests with a JIT date that were
   delivered on time.

6. **QR labels per element** — each production request can print one QR label per
   physical element, encoding the element's IFC GUID (GlobalId). This is the
   physical↔digital link recommended by the BIM/RFID tracking literature: the factory
   sticks the label on the piece; any scan identifies its digital twin.

7. **Crane weather window** — 7-day wind/rain forecast for the site (Open-Meteo),
   classified against crane manufacturer wind limits (~45–50 km/h gusts = lifting at
   risk, ≥ 30 km/h = monitor), with JIT dates of open requests flagged on risky days.

## Deploying to the web — IMPORTANT

TwinFlow is **files + a Node.js server** (`serve.mjs`). Uploading only the files to a
static/FTP web space will NOT work — login and all data go through `/api/...`, which
only exists while the Node process runs. You need a host that runs Node.js:

1. **Render.com (free tier, easiest):** create a "Web Service", upload this folder
   (or connect a Git repo), Build command: `npm install` — Start command: `npm start`.
   Render sets `PORT` automatically (already supported). Note: the free tier's disk is
   ephemeral — `data/` and `models/` reset on redeploy; use a paid disk or a VPS for
   real project data.
2. **Any VPS / company server:** install Node 20+, copy this folder,
   `npm install && npm start` (put it behind HTTPS with a reverse proxy for internet use).
3. **Your own PC on the site/office network:** double-click `start-twinflow.bat` and
   keep the window open. Other devices on the same network use `http://<PC-IP>:8123`.

## Run it

Requires only Node.js (any recent version):

```
node serve.mjs
```

Then open http://localhost:8123. All libraries (three.js, web-ifc WASM, QR codes) are
vendored in `vendor/` and served locally with immutable caching — the app works fully
offline; internet is only used for the weather forecast, address geocoding and SMTP.
The 3D model is parsed lazily (only when the IFC Model view is opened) and the renderer
pauses whenever the 3D view is not visible.

Try it without a model: **IFC Model → Load sample model** (a small IFC4 file with
façade panels, slabs, columns, an edge beam and a parapet, including quantity sets).

## Email to the factory (SMTP)

Every production request has an **✉ Email factory** button, and requests are also
emailed **automatically when submitted**. Two modes:

- **Without configuration** — the button opens your local mail app (mailto) with the
  order pre-filled. Nothing to set up.
- **With SMTP configured** — the server sends the email itself, and the send is
  recorded in the request's timeline. To enable it, copy
  `smtp-config.example.json` to `smtp-config.json` and fill in your credentials,
  then restart the server:

  ```json
  {
    "host": "smtp.gmail.com",
    "port": 465,
    "secure": true,
    "user": "your.email@gmail.com",
    "pass": "your-16-character-app-password",
    "from": "TwinFlow <your.email@gmail.com>"
  }
  ```

  For Gmail you need an **App Password** (Google Account → Security → 2-Step
  Verification → App passwords) — your normal password will not work.
  For a company mailbox (e.g. Microsoft 365) ask IT for the SMTP host/port.

  Setting `"test": true` in the config makes the server pretend to send
  (logged, recorded in the timeline, but nothing is delivered) — useful for demos.

  The factory's address comes from its **Contact** field in the Parties view.
  `smtp-config.json` is never served to the browser.

## Data & multi-party use

- **The server is the source of truth.** Projects, production requests and parties live
  in `data/state.json` on the server (atomic writes), exposed through a REST API
  (`/api/state`, `/api/projects`, `/api/orders`, `/api/parties`). Every device —
  PC, phone, tablet — sees the same data; changes made on one device appear on the
  others within ~15 s (background sync). Request codes (PR-NNNN) are assigned by the
  server, so two devices can never create duplicates.
- The browser keeps only device preferences (role, active project) and an offline
  cache for instant startup. Data from pre-server versions is pushed to the server
  automatically the first time that device connects.
- **IFC files are uploaded to the server's `models/` folder** (one file per project)
  and also cached in the browser (IndexedDB). Open a model once and it is restored
  automatically on the next visit, on project switch, and on any device that reaches
  the server — the browser cache covers offline use. Deleting a project deletes both copies.
- **Status colors (digital twin view):** the 🎨 toggle in the IFC Model view paints each
  element with the status of its production request (gray = not ordered), with a legend —
  the model becomes a live progress map of the site.
- **Mobile friendly:** on phones/tablets the navigation becomes a horizontal bar, the
  3D viewer and panels stack vertically, and the kanban swipes horizontally.
- Use **Export data / Import data** (sidebar) to pass the state between parties as a
  JSON file, or to back it up. Old single-project exports import fine.
- **Acting as** (top-right) switches your role; each role only sees the actions that
  belong to it in the workflow.

## Structure

```
index.html        app shell
css/styles.css    theme
js/store.js       state (multi-project), workflow rules, KPIs, persistence
js/ifc.js         web-ifc parsing + quantity takeoff
js/viewer.js      three.js 3D viewer
js/app.js         views: dashboard, model, QTO, requests (kanban), parties
sample.ifc        demo IFC4 model
serve.mjs         static server + SMTP email API (nodemailer)
```

## Next steps (ideas)

- Real multi-user backend (accounts per party, shared database, notifications)
- QR-code / GUID label generation per element for factory marking and site scanning
- Per-element tracking (each GUID through the pipeline, not just per-request)
- Logistics timestamps (factory out / site arrival / lift start / fixed) to compute
  demurrage and cycle-time KPIs automatically
- Weather feed (IPMA) to correlate productivity with wind/rain conditions

## License

© 2026 José Gabriel Andrade Teixeira — **all rights reserved** (todos os direitos
reservados). The code is published for reading and reference; see [LICENSE](LICENSE)
for what that means in practice.
