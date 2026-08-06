(function () {
  "use strict";

  const els = {
    somaDot: document.getElementById('soma-dot'),
    somaText: document.getElementById('soma-text'),
    condition: document.getElementById('condition'),
    participantId: document.getElementById('participant-id'),
    duration: document.getElementById('duration'),
    startBtn: document.getElementById('start-btn'),
    stopBtn: document.getElementById('stop-btn'),
    sessionError: document.getElementById('session-error'),
    monitor: document.getElementById('monitor'),
    statElapsed: document.getElementById('stat-elapsed'),
    statRemainingWrap: document.getElementById('stat-remaining-wrap'),
    statRemaining: document.getElementById('stat-remaining'),
    statSamples: document.getElementById('stat-samples'),
    statComputed: document.getElementById('stat-computed'),
    resultPanel: document.getElementById('result-panel'),
    resultSummary: document.getElementById('result-summary'),
  };

  function durationLabel(s) {
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(Math.floor(s % 60)).padStart(2, '0');
    return mm + ':' + ss;
  }

  function showError(msg) {
    els.sessionError.textContent = msg;
    els.sessionError.classList.remove('hidden');
  }
  function clearError() {
    els.sessionError.classList.add('hidden');
  }

  // Tracks recording state across polls so an auto-stop (server-side timer,
  // no button click) can still surface a "saved" summary — not just a
  // manual stop-button click.
  let wasRecording = false;
  let lastKnownStats = null;
  let suppressAutoStopNotice = false;

  async function pollStatus() {
    try {
      const res = await fetch('/api/status');
      const s = await res.json();

      els.somaDot.className = 'dot' + (s.soma_connected ? ' ok' : '');
      els.somaText.textContent = s.soma_connected ? 'connected' : 'waiting for connection…';

      if (s.recording) {
        els.startBtn.classList.add('hidden');
        els.stopBtn.classList.remove('hidden');
        els.condition.disabled = true;
        els.participantId.disabled = true;
        els.duration.disabled = true;
        els.monitor.classList.remove('hidden');
        els.statElapsed.textContent = durationLabel(s.elapsed_s);
        els.statSamples.textContent = s.sample_count;
        els.statComputed.textContent = s.computed_count;
        if (s.duration_s) {
          els.statRemainingWrap.classList.remove('hidden');
          els.statRemaining.textContent = durationLabel(s.remaining_s);
        } else {
          els.statRemainingWrap.classList.add('hidden');
        }
        lastKnownStats = {
          condition: s.condition,
          participant_id: s.participant_id,
          sample_count: s.sample_count,
          computed_count: s.computed_count,
        };
      } else {
        els.startBtn.classList.remove('hidden');
        els.stopBtn.classList.add('hidden');
        els.condition.disabled = false;
        els.participantId.disabled = false;
        els.duration.disabled = false;

        if (wasRecording && !suppressAutoStopNotice && lastKnownStats) {
          els.resultSummary.textContent =
            `${lastKnownStats.condition}_${lastKnownStats.participant_id} — ` +
            `auto-stopped at target duration — ${lastKnownStats.sample_count} rr samples, ` +
            `${lastKnownStats.computed_count} computed values`;
          els.resultPanel.classList.remove('hidden');
        }
        suppressAutoStopNotice = false;
        lastKnownStats = null;
      }
      wasRecording = s.recording;
    } catch (err) {
      els.somaText.textContent = 'lost connection to local server';
    }
  }

  els.startBtn.addEventListener('click', async () => {
    clearError();
    const condition = els.condition.value.trim();
    const participant = els.participantId.value.trim();
    const durationRaw = els.duration.value.trim();
    if (!condition || !participant) {
      showError('fill in condition and participant id before starting.');
      return;
    }
    let duration_s;
    if (durationRaw) {
      duration_s = Number(durationRaw);
      if (!Number.isFinite(duration_s) || duration_s <= 0) {
        showError('duration must be a positive number of seconds, or left blank.');
        return;
      }
    }
    try {
      const res = await fetch('/api/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ condition, participant, duration_s }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      els.resultPanel.classList.add('hidden');
      pollStatus();
    } catch (err) {
      showError(err.message);
    }
  });

  els.stopBtn.addEventListener('click', async () => {
    try {
      suppressAutoStopNotice = true; // this is a manual stop, not the poll-detected auto-stop path
      const res = await fetch('/api/session/stop', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      els.resultSummary.textContent =
        `${data.session_id} — ${data.sample_count} rr samples, ${data.computed_count} computed values`;
      els.resultPanel.classList.remove('hidden');
      pollStatus();
    } catch (err) {
      showError(err.message);
    }
  });

  setInterval(pollStatus, 1000);
  pollStatus();
})();
