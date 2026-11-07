# WorkWear dashboard

The supervisor's view: who is wearing a helmet, their heat risk, which zone they are in, and every fall or reported incident. Plain HTML, CSS, and JavaScript, served by the server. There is no build step, and it needs no internet connection.

![Dashboard on a laptop](../docs/img/dashboard-desktop.png)

*Screenshots use the simulator, so every helmet is simulated and its incidents are labeled sample data.*

## 1. Open it

1. Start the server ([`server/README.md`](../server/README.md), sections 1 and 3).
2. Open <http://localhost:8000/> in a browser.

The header says **Connected** when the server answers. On a phone or tablet on the same network, open `http://<laptop IP>:8000/` (find the IP and fix network problems with [`server/README.md` section 5](../server/README.md#5-let-the-esp32-reach-the-server)).

To try it without helmets, run the simulator in a second terminal, and add a few days of sample history once:

```bash
cd server
python3 seed.py                       # 8 sample incidents over the last few days (once)
python3 simulator.py --devices 3      # 3 simulated helmets
```

For a live fall during a demo, run the simulator with `--fall-every 600` (or any number of seconds): the alert line under the header turns red when it arrives. Avoid short intervals like 30 s for demos; they fill the list with dozens of falls. `python3 seed.py --reset` puts the 8-incident history back (it backs up the database first and deletes only sample data).

## 2. What is on the page

The **icon rail** on the left switches sections: **Map**, **Workers** (online / all helmets), **Incidents** (pending count, red), **Heat**, and **Settings**. On wide screens a **searchable worker list** sits beside it: one row per helmet with a hard-hat icon colored by status (red = new fall, grey = offline, otherwise the heat-risk color), the name, and the device ID; click a row for that worker's profile. The address bar follows the page (`#/map`, `#/incident/12`, `#/worker/sim-01`), so the browser's Back button works and a page can be bookmarked.

| Part | What it does |
|---|---|
| **Header** | App name, a **Sample data** badge while simulated helmets or sample incidents are on, **Sound on/off**, and the connection status. |
| **Alert line** | One slim line under the header, always there at the same height, so an alert never moves or covers anything. It reads "No fall alerts" until a fall arrives while the page is open; then it turns **red and pulses**: worker, zone, time, peak g, and how many other new falls there are. Click the text to open the fall, **Show in list** to find it in the Incidents table, or **×** to hide the alert. Falls already in the list when the page opened do not raise it. The browser tab title also shows the count, e.g. "(1) FALL". |
| **Alert sound** | Off when the page opens: browsers block sound until you click something. Click **Sound off** in the header (or the button in Settings) to turn it on; it plays a test beep. |
| **Map** | The floor plan of room 1520 (`zones.json`). Each zone is **shaded by its number of confirmed incidents** (light, medium, dark = 1, 2, 3 or more) with the count on it; past incidents are not drawn one by one. A live fall is **one red marker with a pulsing ring** (at its GPS spot, or a dashed "approximate" spot in its zone) and a red outline on its zone. **Click a zone** to list its incidents beside the map (or over it on smaller screens). Worker dots show who is where, colored by heat risk; click one for the profile. A zone too small for name tags shows initials, then one "3 workers" tag. **Key** (top right of the map) opens a small key. **Time** limits the counts to the last 24 h, 8 h, or hour. |
| **Workers** | A table of helmets: name and device ID, online/offline, zone and how it was found, heat index, last seen. The search box filters it (and the worker list). |
| **Worker profile** | Name (click to rename; Enter saves, Esc cancels), device ID, online/offline, helmet on/off, the zone now and **how it was found** (BLE beacons, GPS, or set on the dashboard = simulated), the zone set on the dashboard (change it here), latest **air temperature, humidity and heat index**, last seen, and their recent incidents. |
| **Incidents** | A table, newest first: date and time, worker, zone, type (fall, injury report, hazard report), peak g, a status pill (**Pending**, **Confirmed**, **Dismissed**), and **View**. Filter by status. **Report injury or hazard** opens the form for things the helmet cannot detect (a cut hand, a wet floor); reports start as Pending. |
| **Incident page** | Opens from View, a zone list, or the alert line. A small floor plan with the zone highlighted and the spot marked, the workers in that zone now, the details, **Confirm**, **Dismiss** (or **Mark new** to undo), **Add note**, and a short **timeline**: received by the server (and "arrived late" when it did), whether this screen showed the alert, and the review status. Review times are not stored by the server, so the timeline shows "Confirmed" without a time. |
| **Heat** | The floor plan tinted by the highest heat index measured in each zone, and a table of workers from hottest to coolest: air temperature, humidity, heat index, heat risk. |
| **Settings** | Alert sound, connection, site map details (zones, GPS calibration status), sample data status, and what the labels mean. |

On a **phone** (700 px or narrower) the rail is a bar at the bottom, the worker list is the Workers section, and tables become stacked rows. Between 700 and 1100 px the worker list column is hidden (search is in the Workers section).

![Dashboard on a phone](../docs/img/dashboard-phone.png)

## 3. What the labels mean

These labels keep the demo honest (see "Honesty rules" in [`CLAUDE.md`](../CLAUDE.md)). Don't remove them.

| Label | Meaning |
|---|---|
| **Sample data** (header badge) | Simulated helmets (device IDs starting with `sim-`) or seeded sample incidents are on. When **everything** shown is sample data, this one badge labels it. When real helmets or real incidents are also present, each sample row also gets its own **Sample** pill, so the two can be told apart. An incident page always says when it is sample data. |
| **Simulated location** | The zone was set on the dashboard; nothing measured where the worker is. **Located by BLE beacons / GPS** means the helmet measured it, and the worker's dot gets a blue ring. |
| **Heat risk** | Based on air temperature and humidity at the helmet (the heat index), **not** body temperature. Colors follow the bands in [`docs/PROTOCOL.md`](../docs/PROTOCOL.md) section 7. |
| **Pending** | Not reviewed yet (the server calls it `new`). Only **confirmed** incidents count on the map. |
| **Arrived late** | The helmet held the fall while its Wi-Fi was down and sent it more than 5 s later. The time shown is when the server got it. |

## 4. Change the site map

Edit [`zones.json`](zones.json). It points at a floor-plan image and draws each zone as a rectangle on it:

```json
{
  "site": "Room 1520, Carlsen Center for Innovation and Entrepreneurship",
  "image": "floorplan.png",
  "width": 555,
  "height": 505,
  "zones": [
    { "id": "1520-W", "label": "1520 West", "x": 122, "y": 95, "w": 115, "h": 334 },
    { "id": "1522", "label": "1522 Seminar Room", "x": 14, "y": 73, "w": 108, "h": 184 }
  ]
}
```

- `image` is a file in `dashboard/`. `width` and `height` are its size in pixels.
- `x`, `y` are a zone's top-left corner and `w`, `h` its size, **in the image's pixels** (measure them in any image editor). The zones follow the image when the page resizes.
- `id` is what is stored on the server (up to 32 characters, no spaces). `label` is what the map, the zone pickers, and the incident list show.
- The zones today: room 1520 is split into **West, North, South, and Alcove**, plus the **1522 Seminar Room** and **1533 Data Tech Lab**. The small offices (1527 to 1531) are on the plan but are not zones; add one with a new line.
- `floorplan.png` is the building plan with the room names inside the zones and the outdoor labels removed, so they don't clash with the zone labels.
- No floor plan? Leave out `image`, `width`, and `height` and use a grid instead: `"cols": 3, "rows": 2`, and give each zone a `"col"` and `"row"` (from 0, top left).
- Mistakes (duplicate IDs, a zone outside the image or grid, a missing image) are skipped and listed above the map. Reload the page after editing.
- If you rename or remove an `id`, workers already set to the old one show under "Not on the map" until you pick a new zone. Their past incidents keep the old zone.

### Put GPS positions on the plan (outdoors)

Off until you add `gps_points`: three or more spots you can find both on the plan and on a map. Building corners work well.

1. Open the dashboard as `http://localhost:8000/?calibrate` and click each spot on the floor plan. The page shows its `x` and `y` in image pixels.
2. For each spot, get its latitude and longitude, for example by right-clicking it in Google Maps.
3. Add them to `zones.json` (spots far apart, not in a line):

   ```json
   "gps_points": [
     { "x": 14,  "y": 20,  "lat": 41.00000, "lon": -96.00000 },
     { "x": 552, "y": 20,  "lat": 41.00000, "lon": -96.00000 },
     { "x": 14,  "y": 489, "lat": 41.00000, "lon": -96.00000 }
   ]
   ```

   (The numbers above are placeholders: use your own.)
4. Reload the page. The server reads the file on its own; `http://localhost:8000/api/site` should say `"gps_ready": true`, and `max_error_px` should be small (a few pixels). A big error means a point was measured wrong.

Falls with a GPS fix then appear at their position, and a GPS fix inside a zone sets the worker's zone. **Indoors the GPS gets no fix**, so inside room 1520 this changes nothing; use beacons for that (`firmware/README.md`).

## 5. Run the tests

You need **Node 18 or newer** (tested on 24). No packages to install.

```bash
cd dashboard
node --test
```

The tests cover the parts that make decisions (heat labels, which falls raise the alert, map placement, report and note checks) in `logic.js`. The page itself was checked by hand and with scripted browser checks; [`PLAN.md`](../PLAN.md) records the results for each phase (D1 to D6).

## Troubleshooting

| Problem | Fix |
|---|---|
| **"Can't reach server"** in red | The server stopped or the network dropped. The page keeps the last data and reconnects by itself. Start the server again (`server/README.md` section 3). |
| The page is blank or unstyled | Open it through the server (`http://localhost:8000/`), not by double-clicking `index.html`. |
| No sound on a fall | Click **Sound off** to turn it on. You need to do this each time the page is opened. |
| "Can't reach server" flickers now and then | The map's per-zone summary (`/api/hazards`) reads every telemetry row; after hours of simulator data on a slow disk (WSL on `/mnt/c`) it can take over 2 s. Pick a shorter **Time** window, or restart with a fresh database. |
| A rename or zone change shows a red message | The server refused or did not answer; the message says why. The old value is kept. |
| The map says zones.json could not be loaded | The file has a JSON error (a missing comma is common). Check it with `python3 -m json.tool dashboard/zones.json`. |
| A worker is not on the map | They have no zone, or a zone not in `zones.json`. Pick one on their profile. |
| An old fall doesn't raise the alert | That is on purpose: only falls that arrive while the page is open do. Check the Incidents table for anything still Pending (the red count on the rail). |
| Every row says "Sample" | Real and sample data are mixed (for example one report entered by hand while the simulator runs), so each sample row is labeled. With only sample data, the header badge alone labels it. |

## Layout

```
dashboard/
  index.html          page structure: header, alert line, rail, worker list, one section per view
  style.css           look and layout; one type scale; rail at the bottom under 700 px
  app.js              loads data every second, follows the address (#/...), draws the current view
  map.js              the floor-plan map (Map, Heat, and the small one on incident pages)
  ui.js               small page helpers (pills, avatars, lists)
  logic.js            decisions without the page (tested)
  api.js              talks to the server (2 s timeout)
  zones.json          the site map: floor plan and zones
  floorplan.png       floor plan of room 1520 used by zones.json
  tests/logic.test.js node --test tests
```
