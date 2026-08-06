# somasync-capture

captures a SomaSync SelfSense stream over WebSocket and consolidates it into
a session json compatible with [hrv-dashboard](../hrv-dashboard)'s ingestion
format — a fallback for when the Polar H10 won't hold a stable direct Web
Bluetooth connection in Chrome (macOS's Bluetooth stack can be flaky about
this; SomaSync connects to the strap natively on the phone instead, and
streams the result out over plain WebSocket, same mechanism
[loob/relay.js](../loob/relay.js) uses for "the 8").

runs as a persistent local server with a browser control panel — start it
once, leave it running, and start/stop a session per participant from the
page without touching the terminal or reconnecting SomaSync in between.

## setup

```
cd somasync-capture
npm install
node server.js
```

open `http://localhost:8080`.

## in SomaSync's streaming settings (on your phone)

the terminal prints the IP/port to use:

| field | value |
|---|---|
| Stream To | WebSocket |
| Server | Custom |
| IP | (printed on start) |
| Port | 8765 |
| Insecure | ON |

connect this once — it can stay connected across multiple participants,
you don't need to reconnect it per session.

## use

1. with SomaSync connected (the page shows a green "connected" dot), fill in
   **condition** and **participant id**, hit **start recording**.
2. the live readout shows elapsed time, rr samples, and computed values.
3. **stop recording** when done — it writes into `../hrv-dashboard/data/sessions/`
   (override with `OUT_DIR=/some/path node server.js`):
   - `<session_id>.json` — consolidated session, same shape rr-logger
     exports: `condition`, `participant_id`, `samples[]` with `rr_ms` per
     beat, plus a `computed_stream[]` for anything SomaSync sends
     already-computed (dfa alpha1, rmssd, sdnn, hr) rather than as a raw
     interval
   - `<session_id>_raw.jsonl` — every raw message received during that
     session, verbatim, with a receipt timestamp
4. repeat step 1 for the next participant — no restart needed.

## why there's a raw log

there's no published SomaSync message schema to build against, so the
field-name matching in `lib/parse.js` (`RR_KEYS`, `COMPUTED_KEY_MAP`) is a
best-effort guess based on the format `loob/the-8.html`'s `parseSoma()`
already knows how to read (`alpha`/`dfaAlpha`/`dfa_alpha`/`fractalIndex`/`dfa`,
or an OSC-style `{bundle:[{address:'/dfa', value}]}`), extended with likely
names for raw beat intervals (`rr`, `ibi`, etc). if a pilot session comes
back with 0 rr samples, open that session's `_raw.jsonl` file — it has the
exact field names SomaSync actually sent, and the extractors in
`lib/parse.js` can be adjusted to match.

## notes

- SomaSync's WebSocket port (8765 by default) is only bound while
  `server.js` is running — don't run `loob/relay.js` at the same time
  unless you pass a different `SOMA_PORT` to one of them.
- if SomaSync only streams precomputed values (no raw rr), the session file
  will have `samples: []` and hrv-dashboard will list it as "not
  analyzable" — the `computed_stream` values are still saved in the json,
  just not run through the dashboard's own DFA pipeline yet.
- this is a local tool — no auth, don't expose it beyond your own network.
