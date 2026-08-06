#!/usr/bin/env node
// SomaSync capture — receives a SomaSync SelfSense stream and consolidates
// it into a session JSON compatible with hrv-dashboard's ingestion format.
//
// We don't have a documented SomaSync message schema, so this does two
// things at once: (1) writes every raw message to a .jsonl log so the
// actual format can be inspected, and (2) makes a best-effort structured
// extraction using the field names already known to work from loob/the-8.html's
// parseSoma() (alpha/dfaAlpha/dfa_alpha/fractalIndex/dfa, and OSC '/dfa'
// bundles), plus a wider guess list for raw rr/ibi and other hrv fields.
//
// Usage:
//   node capture.js --condition baseline --participant 01
//   node capture.js --condition baseline --participant 01 --port 8765 --out ../hrv-dashboard/data/sessions
//
// Then in SomaSync SelfSense streaming settings:
//   Stream to: WebSocket, Server: Custom, IP: <this machine's IP>, Port: 8765, Insecure: ON
//
// Ctrl+C to stop and write the consolidated session file + raw capture log.

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

function parseArgs(argv) {
  const out = { port: 8765, outDir: path.join(__dirname, '..', 'hrv-dashboard', 'data', 'sessions') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--condition') out.condition = argv[++i];
    else if (a === '--participant') out.participant = argv[++i];
    else if (a === '--port') out.port = parseInt(argv[++i], 10);
    else if (a === '--out') out.outDir = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.condition || !args.participant) {
  console.error('usage: node capture.js --condition <name> --participant <id> [--port 8765] [--out <dir>]');
  process.exit(1);
}

function slugify(s) {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'x';
}

const condition = slugify(args.condition);
const participantId = slugify(args.participant);
const sessionStart = new Date();
const sessionId = `${condition}_${participantId}_${sessionStart.toISOString().replace(/[:.]/g, '-')}`;

fs.mkdirSync(args.outDir, { recursive: true });
const rawLogPath = path.join(args.outDir, `${sessionId}_raw.jsonl`);
const rawLogStream = fs.createWriteStream(rawLogPath, { flags: 'a' });

const samples = [];        // raw rr/ibi intervals, in the rr-logger schema
const computedStream = []; // any precomputed metrics the stream sends directly (dfa, rmssd, hr, ...)
let seenFirst = false;

// candidate field names for raw beat-to-beat intervals (ms)
const RR_KEYS = ['rr', 'rr_ms', 'rrMs', 'ibi', 'ibi_ms', 'ibiMs', 'RR', 'IBI', 'interval', 'interval_ms'];

// candidate field names for precomputed metrics -> normalized output field name
const COMPUTED_KEY_MAP = {
  alpha: 'dfa_alpha1', dfaAlpha: 'dfa_alpha1', dfa_alpha: 'dfa_alpha1',
  fractalIndex: 'dfa_alpha1', dfa: 'dfa_alpha1', dfaAlpha1: 'dfa_alpha1',
  rmssd: 'rmssd', RMSSD: 'rmssd',
  sdnn: 'sdnn', SDNN: 'sdnn',
  hr: 'hr', bpm: 'hr', heartRate: 'hr', heart_rate: 'hr',
};

function plausibleRR(n) {
  return typeof n === 'number' && n > 250 && n < 2500;
}

function extractRR(d) {
  const out = [];
  for (const key of RR_KEYS) {
    if (d[key] == null) continue;
    const v = d[key];
    if (Array.isArray(v)) out.push(...v.map(Number).filter(plausibleRR));
    else if (plausibleRR(Number(v))) out.push(Number(v));
  }
  if (Array.isArray(d.bundle)) {
    for (const b of d.bundle) {
      if (typeof b.address === 'string' && /rr|ibi/i.test(b.address) && plausibleRR(Number(b.value))) {
        out.push(Number(b.value));
      }
    }
  }
  return out;
}

function extractComputed(d) {
  const out = [];
  for (const [key, field] of Object.entries(COMPUTED_KEY_MAP)) {
    if (typeof d[key] === 'number') out.push([field, d[key]]);
  }
  if (Array.isArray(d.bundle)) {
    for (const b of d.bundle) {
      if (b.address === '/dfa' && b.value != null) out.push(['dfa_alpha1', parseFloat(b.value)]);
    }
  }
  return out;
}

function localIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const wss = new WebSocket.Server({ port: args.port });

console.log(`
╔══════════════════════════════════════════╗
║  somasync capture                        ║
╠══════════════════════════════════════════╣
║  condition:    ${condition.padEnd(27)}║
║  participant:  ${participantId.padEnd(27)}║
║                                          ║
║  SomaSync → Streaming Settings:          ║
║  Stream To:  WebSocket                   ║
║  Server:     Custom                      ║
║  IP:         ${localIP().padEnd(16)}            ║
║  Port:       ${String(args.port).padEnd(16)}            ║
║  Insecure:   ON  ← important             ║
╚══════════════════════════════════════════╝

waiting for connection... (ctrl+c to stop and save)
`);

wss.on('connection', (ws) => {
  console.log('somasync connected');
  ws.on('message', (data) => {
    const receiptMs = Date.now();
    const text = data.toString();
    rawLogStream.write(JSON.stringify({ t: receiptMs, raw: text }) + '\n');

    if (!seenFirst) {
      seenFirst = true;
      console.log('\n── first message received ──');
      console.log(text);
      console.log('─────────────────────────────\n');
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // non-JSON message; still captured in the raw log
    }

    for (const rr of extractRR(parsed)) {
      samples.push({
        timestamp_iso: new Date(receiptMs).toISOString(),
        timestamp_ms_unix: receiptMs,
        rr_ms: rr,
        session_id: sessionId,
        condition,
        participant_id: participantId,
      });
    }

    for (const [field, value] of extractComputed(parsed)) {
      computedStream.push({
        timestamp_iso: new Date(receiptMs).toISOString(),
        timestamp_ms_unix: receiptMs,
        field,
        value,
      });
    }

    process.stdout.write(`\rrr samples: ${samples.length}   computed values: ${computedStream.length}   `);
  });

  ws.on('close', () => console.log('\nsomasync disconnected'));
  ws.on('error', (e) => console.log('\nsomasync error:', e.message));
});

function save() {
  const sessionPath = path.join(args.outDir, `${sessionId}.json`);
  const output = {
    session_id: sessionId,
    condition,
    participant_id: participantId,
    source: 'somasync-selfsense',
    recorded_at: sessionStart.toISOString(),
    sample_count: samples.length,
    samples,
    computed_stream: computedStream,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(output, null, 2));
  rawLogStream.end();

  console.log(`\n\nsaved ${sessionPath}`);
  console.log(`  rr samples: ${samples.length}`);
  console.log(`  computed values: ${computedStream.length}`);
  console.log(`  raw capture: ${rawLogPath}`);
  if (samples.length === 0) {
    console.log(
      '\nno raw rr/ibi values recognized in the stream — check the raw capture ' +
      'log above to see the actual field names, and share it so the parser can be fixed.'
    );
  }
  process.exit(0);
}

process.on('SIGINT', save);
process.on('SIGTERM', save);
