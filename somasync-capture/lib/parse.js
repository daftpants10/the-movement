// Best-effort field extraction from a SomaSync SelfSense message.
// No documented schema to build against — see README for how to correct
// this against a real capture if a pilot comes back with 0 rr samples.

function slugify(s) {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'x';
}

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

module.exports = { slugify, extractRR, extractComputed };
