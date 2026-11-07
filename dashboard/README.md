# WorkWear dashboard

The supervisor's view: who is wearing a helmet, their heat risk, which zone they are in, and every fall or reported incident. Plain HTML, CSS, and JavaScript, served by the server. There is no build step, and it needs no internet connection.

![Dashboard on a laptop](../docs/img/dashboard-desktop.png)

*Screenshots use the simulator, so every helmet is simulated and its incidents are labeled sample data.*

## 1. Open it

1. Start the server ([`server/README.md`](../server/README.md), sections 1 and 3).
2. Open <http://localhost:8000/> in a browser.

The header says **Connected** when the server answers. On a phone or tablet on the same network, open `http://<laptop IP>:8000/` (find the IP and fix network problems with [`server/README.md` section 5](../server/README.md#5-let-the-esp32-reach-the-server)).

To try it without helmets, run the simulator in a second terminal:

```bash
cd server
python3 simulator.py --devices 3 --fall-every 30 --heat-ramp 5
```

Three simulated helmets appear within a second. Every 30 s one of them "falls", and the red alert banner comes up.

## 2. What is on the page

| Part | What it does |
|---|---|
| **Alert banner** | Comes up for each fall that arrives while the page is open, with who, where, when, and the peak g. It stays until you click **Hide alert**. Falls that were already in the list when the page opened do not raise it. The browser tab title also shows the count, e.g. "(1) FALL". |
| **Alert sound** | Off when the page opens: browsers block sound until you click something. Click **Alert sound: off** to turn it on (it plays a test beep). |
| **Tiles** | Workers online, new (unreviewed) incidents, recent incidents, simulated helmets. |
| **Workers** | One card per helmet: name, online/offline (offline = nothing for 5 s), heat risk color and reading, helmet on/off, last seen. **Click the name to rename** (Enter saves, Esc cancels). **Pick a zone** from the list to say where the worker is. Both are saved on the server, and new incidents use the name and zone at that moment. |
| **Site map** | The zone grid from `zones.json`. A dot per worker in their zone, colored by heat risk. A worker with a new fall gets a red ring until the alert is hidden. Workers without a zone are listed under "Not on the map". |
| **Map layers** | **Incidents** shades each zone by its number of **confirmed** incidents (darker = more). **Heat** colors each zone by the highest heat index measured there. **Time** limits both to the last 24 h, 8 h, or hour. |
| **Incidents** | Newest first, with badges: New / Confirmed / Dismissed, Sample data, Arrived late. **Confirm** a real incident, **Dismiss** a false alarm, or **Mark new** to undo. Add or edit a note on any incident. Confirming or dismissing a fall also clears its alert. |
| **Report injury or hazard** | For things the helmet cannot detect, such as a cut hand or a wet floor. Pick the type and zone, and optionally the helmet (its name is copied) or a typed name. Reports start as New; confirm them for them to count on the map. |

![Dashboard on a phone](../docs/img/dashboard-phone.png)

## 3. What the labels mean

These labels keep the demo honest (see "Honesty rules" in [`CLAUDE.md`](../CLAUDE.md)). Don't remove them.

| Label | Meaning |
|---|---|
| **Simulated helmet** | The device ID starts with `sim-`: it is the simulator, not hardware. |
| **Sample data** | An incident from a simulated helmet. Zone counts on the map say "(includes N sample)" when they contain any. |
| **Simulated location** | Zones are set by hand on the worker cards; nothing measures where the worker is. |
| **Heat risk** | Based on air temperature and humidity at the helmet (the heat index), **not** body temperature. Colors follow the bands in [`docs/PROTOCOL.md`](../docs/PROTOCOL.md) section 7. |
| **Arrived late** | The helmet held the fall while its Wi-Fi was down and sent it more than 5 s later. The time shown is when the server got it. |

## 4. Change the site map

Edit [`zones.json`](zones.json). The default is a generic 3 x 2 grid:

```json
{
  "site": "Demo site (generic grid)",
  "cols": 3,
  "rows": 2,
  "zones": [
    { "id": "A1", "label": "A1", "col": 0, "row": 0 },
    { "id": "B3", "label": "B3", "col": 2, "row": 1 }
  ]
}
```

- `id` is what is stored on the server. `label` is what the map shows (e.g. `"Stairwell"`). `col` and `row` count from 0, top left.
- A zone can be left out to leave a gap. Reload the page after editing.
- Mistakes (duplicate IDs, a zone outside the grid) are skipped and listed above the map.
- If you rename or remove an `id`, workers already set to the old one show under "Not on the map" until you pick a new zone. Their past incidents keep the old zone.

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
| No sound on a fall | Click **Alert sound: off** to turn it on. You need to do this each time the page is opened. |
| A rename or zone change shows a red message | The server refused or did not answer; the message says why. The old value is kept. |
| The map says zones.json could not be loaded | The file has a JSON error (a missing comma is common). Check it with `python3 -m json.tool dashboard/zones.json`. |
| A worker is not on the map | They have no zone, or a zone not in `zones.json`. Pick one on their card. |
| An old fall doesn't raise the alert | That is on purpose: only falls that arrive while the page is open do. Check the list for anything still marked New. |

## Layout

```
dashboard/
  index.html          page structure
  style.css           look and layout (stacks into one column under 900 px)
  app.js              loads data every second and draws the page
  logic.js            decisions without the page (tested)
  api.js              talks to the server (2 s timeout)
  zones.json          the site map grid
  tests/logic.test.js node --test tests
```
