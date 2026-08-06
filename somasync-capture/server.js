#!/usr/bin/env node
// SomaSync capture — persistent server + browser control panel.
//
// Run once, leave running. SomaSync connects once (native Bluetooth to the
// H10 on your phone) and streams continuously to the WebSocket port below.
// Use the browser page to start/stop a named session per participant
// without touching the terminal or restarting anything in between.
//
//   node server.js
//   open http://localhost:8080
//
// SomaSync streaming settings: Stream To WebSocket, Server Custom,
// IP/Port as printed on start, Insecure ON.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { slugify, extractRR, extractComputed } = require('./lib/parse');

const HTTP_PORT = parseInt(process.env.PORT || '8080', 10);
const SOMA_PORT = parseInt(process.env.SOMA_PORT || '8765', 10);
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, '..', 'hrv-dashboard', 'data', 'sessions');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(OUT_DIR, { recursive: true });

function localIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

let somaConnected = false;
let session = null; // set by /api/session/start, cleared by /api/session/stop

function startSession(conditionRaw, participantRaw, durationS) {
  const condition = slugify(conditionRaw);
  const participantId = slugify(participantRaw);
  const sessionStart = new Date();
  const sessionId = `${condition}_${participantId}_${sessionStart.toISOString().replace(/[:.]/g, '-')}`;
  const rawPath = path.join(OUT_DIR, `${sessionId}_raw.jsonl`);
  session = {
    condition,
    participantId,
    sessionId,
    sessionStart,
    durationS: durationS || null,
    autoStopTimer: null,
    autoStopped: false,
    samples: [],
    computedStream: [],
    rawStream: fs.createWriteStream(rawPath, { flags: 'a' }),
    rawPath,
  };
  if (durationS) {
    session.autoStopTimer = setTimeout(() => {
      if (session) {
        session.autoStopped = true;
        console.log(`\nduration reached (${durationS}s) — auto-stopping`);
        stopSession();
      }
    }, durationS * 1000);
  }
  return session;
}

function stopSession() {
  if (!session) return null;
  const s = session;
  if (s.autoStopTimer) clearTimeout(s.autoStopTimer);
  const sessionPath = path.join(OUT_DIR, `${s.sessionId}.json`);
  const output = {
    session_id: s.sessionId,
    condition: s.condition,
    participant_id: s.participantId,
    source: 'somasync-selfsense',
    recorded_at: s.sessionStart.toISOString(),
    target_duration_s: s.durationS,
    sample_count: s.samples.length,
    samples: s.samples,
    computed_stream: s.computedStream,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(output, null, 2));
  s.rawStream.end();
  session = null;
  return {
    session_id: s.sessionId,
    session_path: sessionPath,
    raw_path: s.rawPath,
    sample_count: output.sample_count,
    computed_count: output.computed_stream.length,
    auto_stopped: s.autoStopped,
  };
}

// --- SomaSync WebSocket (always listening; buffers only while a session is active) ---

const wss = new WebSocket.Server({ port: SOMA_PORT });

wss.on('error', (e) => {
  console.error(`\ncould not bind the somasync websocket port ${SOMA_PORT}: ${e.message}`);
  if (e.code === 'EADDRINUSE') {
    console.error(`something else is already using port ${SOMA_PORT} — stop it, or run with SOMA_PORT=<other port> node server.js`);
  }
  process.exit(1);
});

wss.on('connection', (ws) => {
  somaConnected = true;
  console.log('somasync connected');

  ws.on('message', (data) => {
    const receiptMs = Date.now();
    const text = data.toString();

    if (!session) return; // no active session; nothing to log into

    session.rawStream.write(JSON.stringify({ t: receiptMs, raw: text }) + '\n');

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    for (const rr of extractRR(parsed)) {
      session.samples.push({
        timestamp_iso: new Date(receiptMs).toISOString(),
        timestamp_ms_unix: receiptMs,
        rr_ms: rr,
        session_id: session.sessionId,
        condition: session.condition,
        participant_id: session.participantId,
      });
    }

    for (const [field, value] of extractComputed(parsed)) {
      session.computedStream.push({
        timestamp_iso: new Date(receiptMs).toISOString(),
        timestamp_ms_unix: receiptMs,
        field,
        value,
      });
    }
  });

  ws.on('close', () => {
    somaConnected = false;
    console.log('somasync disconnected');
  });
  ws.on('error', (e) => console.log('somasync error:', e.message));
});

// --- HTTP control panel + API ---

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath);
    const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/session/start') {
    try {
      const { condition, participant, duration_s } = JSON.parse((await readBody(req)) || '{}');
      if (!condition || !participant) return sendJson(res, 400, { error: 'condition and participant required' });
      if (session) return sendJson(res, 409, { error: 'a session is already recording' });

      let durationS = null;
      if (duration_s !== undefined && duration_s !== null && duration_s !== '') {
        durationS = Number(duration_s);
        if (!Number.isFinite(durationS) || durationS <= 0) {
          return sendJson(res, 400, { error: 'duration_s must be a positive number' });
        }
      }

      const s = startSession(condition, participant, durationS);
      return sendJson(res, 200, { session_id: s.sessionId, duration_s: s.durationS });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (req.method === 'POST' && req.url === '/api/session/stop') {
    const result = stopSession();
    if (!result) return sendJson(res, 400, { error: 'no session in progress' });
    return sendJson(res, 200, result);
  }

  if (req.method === 'GET' && req.url === '/api/status') {
    const elapsedS = session ? (Date.now() - session.sessionStart.getTime()) / 1000 : 0;
    return sendJson(res, 200, {
      soma_connected: somaConnected,
      recording: !!session,
      condition: session ? session.condition : null,
      participant_id: session ? session.participantId : null,
      sample_count: session ? session.samples.length : 0,
      computed_count: session ? session.computedStream.length : 0,
      elapsed_s: elapsedS,
      duration_s: session ? session.durationS : null,
      remaining_s: session && session.durationS ? Math.max(0, session.durationS - elapsedS) : null,
    });
  }

  serveStatic(req, res);
});

server.on('error', (e) => {
  console.error(`\ncould not bind the control panel port ${HTTP_PORT}: ${e.message}`);
  if (e.code === 'EADDRINUSE') {
    console.error(`something else is already using port ${HTTP_PORT} — stop it, or run with PORT=<other port> node server.js`);
  }
  process.exit(1);
});

server.listen(HTTP_PORT, () => {
  console.log(`
control panel:    http://localhost:${HTTP_PORT}

SomaSync → Streaming Settings:
  Stream To:  WebSocket
  Server:     Custom
  IP:         ${localIP()}
  Port:       ${SOMA_PORT}
  Insecure:   ON

sessions save into: ${OUT_DIR}
`);
});
