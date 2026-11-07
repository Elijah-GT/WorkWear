# WorkWear server

FastAPI + SQLite server for the helmets and the dashboard. Every route and field is defined in [`docs/PROTOCOL.md`](../docs/PROTOCOL.md); read that first.

You need **Python 3.12 or newer** (tested on 3.14). All commands below run from this `server/` folder.

## 1. Install (once)

macOS / Linux / WSL:

```bash
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Windows (PowerShell):

```powershell
cd server
py -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

The rest of this guide uses the macOS/Linux paths. On Windows, use `.venv\Scripts\` instead of `.venv/bin/`.

> **WSL tip:** a venv inside `/mnt/c/...` (the Windows drive) is very slow to install into, because WSL reads Windows files slowly. Installing takes minutes instead of seconds. It still works; it just takes a while.

## 2. Run the tests

```bash
.venv/bin/python -m pytest
```

All tests should pass. They use a temporary database, so they never touch your real data.

## 3. Start the server

```bash
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

- `--host 0.0.0.0` lets other devices on the network (the helmets) reach it. For use on your own laptop only, leave it out.
- Check it is running: open <http://localhost:8000/docs> for the interactive API page, or <http://localhost:8000/api/devices> (shows `[]` until a helmet reports in).
- The database is `server/workwear.db`, created on first start. To use a different file, set `WORKWEAR_DB=/path/to/file.db`. To start from empty, stop the server and delete `workwear.db`, `workwear.db-wal`, and `workwear.db-shm`.
- The server also serves the supervisor dashboard at <http://localhost:8000/> (see [`dashboard/README.md`](../dashboard/README.md)).
- Press Ctrl+C to stop.

## 4. Run fake helmets (simulator)

In a second terminal, with the server running:

```bash
python3 simulator.py --devices 3 --fall-every 30
```

The simulator only uses Python's standard library, so it needs no venv. Helmets `sim-01`, `sim-02`, ... appear in `GET /api/devices` within a second, and a fall arrives every 30 s. **Everything from a `sim-` device is marked sample data**; the dashboard must label it as such.

| Option | What it does |
|---|---|
| `--url URL` | Server address (default `http://localhost:8000`) |
| `--devices N` | Number of helmets, 1-99 (default 3) |
| `--fall-every S` | A fall from a random helmet every S seconds (default: never) |
| `--heat-ramp C` | Warm every helmet by C degrees per minute, up to 50 C, to watch heat colors change |
| `--resend` | Send each fall twice, to check the server does not duplicate it |
| `--duration S` | Stop after S seconds (default: run until Ctrl+C) |
| `--seed N` | Same random values every run |

If the server is down, the simulator prints one warning and keeps retrying falls every 2 s, like a real helmet.

## 5. Let the ESP32 reach the server

The helmet and the laptop must be on the **same 2.4 GHz network** (a phone hotspot; campus Wi-Fi often blocks device-to-device traffic).

1. Find the laptop's IP address on that network:
   - Windows: `ipconfig` (look under the Wi-Fi adapter, "IPv4 Address")
   - macOS: `ipconfig getifaddr en0`
   - Linux: `hostname -I`
2. Put `http://<that IP>:8000` in `firmware/config.h`.
3. Test from a **phone on the same hotspot**: open `http://<that IP>:8000/api/devices`. If the phone can't load it, the ESP32 can't either; fix that first (see below).
4. Allow port 8000 through the laptop's firewall if it asks (Windows will pop up a prompt the first time; choose *Private networks*).

### Running the server inside WSL2

By default, WSL2 is hidden behind Windows, so **other devices cannot reach a server running in WSL**, even though `localhost` works on the laptop itself. Pick one fix:

- **Simplest: run the server with Windows Python** instead of WSL (section 1, Windows commands). Nothing else to set up.
- **Windows 11: mirrored networking.** Add this to `C:\Users\<you>\.wslconfig`, then run `wsl --shutdown` in PowerShell and reopen WSL:
  ```ini
  [wsl2]
  networkingMode=mirrored
  ```
  Then allow the port in an **admin** PowerShell:
  ```powershell
  New-NetFirewallHyperVRule -Name WorkWear8000 -DisplayName "WorkWear 8000" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 8000
  ```
- **Windows 10 or 11: port forwarding.** In an **admin** PowerShell (redo after each reboot, because the WSL address changes):
  ```powershell
  $wsl = (wsl hostname -I).Trim().Split(" ")[0]
  netsh interface portproxy add v4tov4 listenport=8000 listenaddress=0.0.0.0 connectport=8000 connectaddress=$wsl
  New-NetFirewallRule -DisplayName "WorkWear 8000" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow
  ```

Whichever you choose, test with a phone (step 3 above) before plugging in the helmet.

## Troubleshooting

| Problem | Fix |
|---|---|
| pytest crashes with `No module named 'osrf_pycommon'` or other ROS errors | ROS's `PYTHONPATH` is leaking in. `pytest.ini` already blocks ROS's pytest plugin; if something else breaks, run with `env -u PYTHONPATH .venv/bin/python -m pytest`. |
| The server misbehaves on a machine with ROS sourced | Start it with `env -u PYTHONPATH .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000` so ROS packages can't replace the server's own. |
| `address already in use` | Another server is on port 8000. Stop it, or use `--port 8001` (and the same port in the simulator's `--url` and the firmware). |
| Phone/ESP32 can't reach the server | Same network? `--host 0.0.0.0`? Firewall prompt accepted? Running in WSL (see above)? |
| `422` errors in the simulator or helmet log | The message doesn't match `docs/PROTOCOL.md`; the reply says which field. |
| A helmet shows offline | No telemetry in the last 5 s. Check its Wi-Fi and the server address in `firmware/config.h`. |

## Layout

```
server/
  app/main.py     routes
  app/db.py       SQLite schema and queries
  app/models.py   request shapes (bad requests get a 422)
  app/heat.py     heat index -> heat_level bands
  simulator.py    fake helmets
  tests/          pytest tests, one file per area
```
