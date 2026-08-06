# somasync-capture

captures a SomaSync SelfSense stream over WebSocket and consolidates it into
a session json compatible with [hrv-dashboard](../hrv-dashboard)'s ingestion
format — a fallback for when the Polar H10 won't hold a stable direct Web
Bluetooth connection in Chrome (macOS's Bluetooth stack can be flaky about
this; SomaSync connects to the strap over native Bluetooth instead and
streams the result out over plain WebSocket, same mechanism
[loob/relay.js](../loob/relay.js) uses for "the 8").

## setup

```
cd somasync-capture
npm install
```

## use

```
node capture.js --condition baseline --participant 01
```

this starts a WebSocket server on port 8765 and prints the IP/port to put
into SomaSync's streaming settings:

| field | value |
|---|---|
| Stream To | WebSocket |
| Server | Custom |
| IP | (printed on start) |
| Port | 8765 |
| Insecure | ON |

record a session, then **ctrl+c** to stop — it writes two files into
`../hrv-dashboard/data/sessions/` (override with `--out <dir>`):

- `<session_id>.json` — consolidated session, same shape rr-logger exports:
  `condition`, `participant_id`, `samples[]` with `rr_ms` per beat, plus a
  `computed_stream[]` for anything SomaSync sends already-computed (dfa
  alpha1, rmssd, sdnn, hr) rather than as a raw interval
- `<session_id>_raw.jsonl` — every raw message received, verbatim, with a
  receipt timestamp — check this if the parsed output looks wrong

## why there's a raw log

there's no published SomaSync message schema to build against, so the
field-name matching in `capture.js` (`RR_KEYS`, `COMPUTED_KEY_MAP`) is a
best-effort guess based on the format `loob/the-8.html`'s `parseSoma()`
already knows how to read (`alpha`/`dfaAlpha`/`dfa_alpha`/`fractalIndex`/`dfa`,
or an OSC-style `{bundle:[{address:'/dfa', value}]}`), extended with likely
names for raw beat intervals (`rr`, `ibi`, etc). if a pilot session comes
back with 0 rr samples, open the `_raw.jsonl` file — it has the exact field
names SomaSync actually sends, and the extractors in `capture.js` can be
adjusted to match.

## notes

- run this instead of (not alongside) `loob/relay.js` if both would bind
  port 8765 at once — pass `--port` to either if you need them running
  together.
- if SomaSync only streams precomputed values (no raw rr), the session file
  will have `samples: []` and hrv-dashboard will list it as "not
  analyzable" — the `computed_stream` values are still saved in the json,
  just not run through the dashboard's own DFA pipeline yet.
