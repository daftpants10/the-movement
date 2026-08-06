(function () {
  "use strict";

  let sessions = [];

  // --- tabs -----------------------------------------------------------

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    });
  });

  // --- fetch helpers ----------------------------------------------------

  async function getJson(url) {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  }

  // --- formatting ---------------------------------------------------------

  function fmt(v, digits) {
    if (v === null || v === undefined) return '—';
    return typeof v === 'number' ? v.toFixed(digits === undefined ? 2 : digits) : v;
  }

  function durationLabel(s) {
    if (s === null || s === undefined) return '—';
    const totalSeconds = Math.round(s);
    const mm = Math.floor(totalSeconds / 60);
    const ss = totalSeconds % 60;
    return mm + ':' + String(ss).padStart(2, '0');
  }

  // --- sparkline --------------------------------------------------------

  // ours: our own windowed alpha1 ([{t_start_s,t_end_s,alpha1}]).
  // sourceSeries: optional comparison series from source_computed
  // ([{t_s,value}]) — e.g. the data source's own live alpha1 estimate.
  function sparklineSvg(ours, width, height, sourceSeries, sourceLabel) {
    width = width || 480;
    height = height || 90;
    const pad = 8;
    const hasOurs = ours && ours.length >= 2;
    const hasSource = sourceSeries && sourceSeries.length >= 2;
    if (!hasOurs && !hasSource) {
      return '<p class="status-text">not enough data for a trend chart.</p>';
    }

    const oursPoints = hasOurs
      ? ours.map((w) => ({ t: (w.t_start_s + w.t_end_s) / 2, v: w.alpha1 }))
      : [];
    const sourcePoints = hasSource
      ? sourceSeries.map((p) => ({ t: p.t_s, v: p.value }))
      : [];
    const allValues = oursPoints.map((p) => p.v).concat(sourcePoints.map((p) => p.v));
    const min = Math.min(...allValues);
    const max = Math.max(...allValues);
    const tMax = Math.max(
      oursPoints.length ? oursPoints[oursPoints.length - 1].t : 0,
      sourcePoints.length ? sourcePoints[sourcePoints.length - 1].t : 0
    ) || 1;

    function toPolyline(points, color) {
      if (points.length < 2) return '';
      const range = (max - min) || 1;
      const coords = points.map((p) => {
        const x = pad + (p.t / tMax) * (width - pad * 2);
        const y = height - pad - ((p.v - min) / range) * (height - pad * 2);
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
      return `<polyline points="${coords}" fill="none" stroke="${color}" stroke-width="2" />`;
    }

    // reference line at alpha1 = 0.75 (common vt1-adjacent landmark in the literature)
    const refY = height - pad - ((0.75 - min) / ((max - min) || 1)) * (height - pad * 2);
    const refLine = (0.75 >= min && 0.75 <= max)
      ? `<line x1="${pad}" y1="${refY.toFixed(1)}" x2="${width - pad}" y2="${refY.toFixed(1)}" stroke="#e4dccc" stroke-dasharray="3,3" />`
      : '';

    const legend = hasSource
      ? `<p class="status-text"><span style="color:#e8501f">■</span> dashboard (whole-session windows) &nbsp; <span style="color:#8a8378">■</span> ${sourceLabel || 'source'}</p>`
      : '';

    return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" width="100%" height="${height}">
      ${refLine}
      ${toPolyline(sourcePoints, '#8a8378')}
      ${toPolyline(oursPoints, '#e8501f')}
    </svg>
    <p class="status-text">min ${min.toFixed(3)}, max ${max.toFixed(3)} (dashed line = 0.75)</p>
    ${legend}`;
  }

  function sourceComparisonTable(sourceComputed, session) {
    const fields = Object.keys(sourceComputed || {});
    if (fields.length === 0) return '';
    const rows = fields.map((field) => {
      const s = sourceComputed[field];
      const oursVal = s.ours_field ? session[s.ours_field] : null;
      const oursCell = oursVal !== null && oursVal !== undefined ? fmt(oursVal, 3) : '<span class="muted">no equivalent</span>';
      return `<tr>
        <td>${field}</td>
        <td class="num">${s.count}</td>
        <td class="num">${fmt(s.mean, 3)}</td>
        <td class="num">${fmt(s.min, 3)}-${fmt(s.max, 3)}</td>
        <td class="num">${oursCell}</td>
      </tr>`;
    }).join('');
    return `<h2 style="margin-top:18px">source's own values</h2>
      <p class="status-text">whatever the data source streamed as already-computed, alongside what the dashboard computes itself from the raw rr intervals. these are independent calculations and won't necessarily match.</p>
      <table>
        <thead><tr><th>field</th><th>n</th><th>mean</th><th>range</th><th>dashboard's own</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // --- sessions table -----------------------------------------------------

  function renderSessionsTable() {
    const wrap = document.getElementById('sessions-wrap');
    if (sessions.length === 0) {
      wrap.innerHTML = '<p class="status-text">no data yet. drop json exports above and rescan.</p>';
      return;
    }
    const rows = sessions.map((s) => `
      <tr class="clickable" data-session-id="${s.session_id}">
        <td>${s.condition}</td>
        <td>${s.participant_id}</td>
        <td class="muted">${s.recorded_at ? s.recorded_at.slice(0, 19).replace('T', ' ') : '—'}</td>
        <td class="num">${durationLabel(s.duration_s)}</td>
        <td class="num">${s.sample_count}</td>
        <td class="num">${s.artifact_pct}%</td>
        <td class="num">${fmt(s.mean_hr, 1)}</td>
        <td class="num">${fmt(s.sdnn, 1)}</td>
        <td class="num">${fmt(s.rmssd, 1)}</td>
        <td class="num">${s.analyzable && s.alpha1 !== null ? fmt(s.alpha1, 3) : '<span class="pill warn">n/a</span>'}</td>
      </tr>`).join('');
    wrap.innerHTML = `<table>
      <thead><tr>
        <th>condition</th><th>participant</th><th>recorded</th><th>duration</th>
        <th>n</th><th>artifacts</th><th>hr</th><th>sdnn</th><th>rmssd</th><th>alpha1</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
    wrap.querySelectorAll('tr.clickable').forEach((tr) => {
      tr.addEventListener('click', () => openSessionModal(tr.dataset.sessionId));
    });
  }

  // --- overview grid ----------------------------------------------------

  async function renderOverview() {
    const wrap = document.getElementById('overview-wrap');
    try {
      const data = await getJson('/api/overview');
      if (data.participants.length === 0) {
        wrap.innerHTML = '<p class="status-text">no data yet.</p>';
        return;
      }
      const header = '<th>participant</th>' + data.conditions.map((c) => `<th>${c}</th>`).join('');
      const rows = data.participants.map((p) => {
        const cells = data.conditions.map((c) => {
          const cell = data.grid[p] && data.grid[p][c];
          if (!cell) return '<td class="muted">—</td>';
          if (!cell.analyzable || cell.alpha1 === null) {
            return `<td class="clickable-cell pill warn" data-session-id="${cell.session_id}">n/a</td>`;
          }
          return `<td class="num clickable-cell" data-session-id="${cell.session_id}">${cell.alpha1.toFixed(3)}</td>`;
        }).join('');
        return `<tr><td>${p}</td>${cells}</tr>`;
      }).join('');
      wrap.innerHTML = `<table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
      wrap.querySelectorAll('.clickable-cell').forEach((td) => {
        td.style.cursor = 'pointer';
        td.addEventListener('click', () => openSessionModal(td.dataset.sessionId));
      });
    } catch (err) {
      wrap.innerHTML = `<p class="status-text">${err.message}</p>`;
    }
  }

  // --- session detail modal ----------------------------------------------

  async function openSessionModal(sessionId) {
    const backdrop = document.getElementById('modal-backdrop');
    const body = document.getElementById('modal-body');
    document.getElementById('modal-title').textContent = sessionId;
    body.innerHTML = '<p class="status-text">loading…</p>';
    backdrop.classList.remove('hidden');
    try {
      const s = await getJson('/api/sessions/' + encodeURIComponent(sessionId));
      let html = `
        <table>
          <tr><td class="muted">condition</td><td>${s.condition}</td></tr>
          <tr><td class="muted">participant</td><td>${s.participant_id}</td></tr>
          <tr><td class="muted">recorded</td><td>${s.recorded_at || '—'}</td></tr>
          <tr><td class="muted">duration</td><td>${durationLabel(s.duration_s)}</td></tr>
          <tr><td class="muted">samples</td><td>${s.sample_count} (${s.n_artifacts} artifacts, ${s.artifact_pct}%)</td></tr>
        </table>`;
      if (!s.analyzable) {
        html += `<p class="status-text">${s.reason}</p>`;
      } else {
        html += `<table>
          <tr><td class="muted">mean hr</td><td>${fmt(s.mean_hr, 1)} bpm</td></tr>
          <tr><td class="muted">sdnn</td><td>${fmt(s.sdnn, 1)} ms</td></tr>
          <tr><td class="muted">rmssd</td><td>${fmt(s.rmssd, 1)} ms</td></tr>
          <tr><td class="muted">pnn50</td><td>${fmt(s.pnn50, 1)}%</td></tr>
          <tr><td class="muted">dfa alpha1</td><td>${s.alpha1 !== null ? fmt(s.alpha1, 4) : (s.alpha1_note || 'n/a')}</td></tr>
        </table>`;
        const dfaSource = s.source_computed && s.source_computed.dfa_alpha1;
        html += sparklineSvg(s.alpha1_windowed, null, null, dfaSource && dfaSource.series, "source's own dfa alpha1");
      }
      html += sourceComparisonTable(s.source_computed, s);
      body.innerHTML = html;
    } catch (err) {
      body.innerHTML = `<p class="status-text">${err.message}</p>`;
    }
  }

  document.getElementById('modal-close').addEventListener('click', () => {
    document.getElementById('modal-backdrop').classList.add('hidden');
  });
  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') e.target.classList.add('hidden');
  });

  // --- dropdowns ----------------------------------------------------------

  function populateSelects() {
    const participants = [...new Set(sessions.map((s) => s.participant_id))].sort();
    const conditions = [...new Set(sessions.map((s) => s.condition))].sort();

    const pSel = document.getElementById('participant-select');
    const cSel = document.getElementById('condition-select');
    pSel.innerHTML = participants.map((p) => `<option value="${p}">${p}</option>`).join('');
    cSel.innerHTML = conditions.map((c) => `<option value="${c}">${c}</option>`).join('');

    showParticipantSessions();
    showConditionSessions();
  }

  function showParticipantSessions() {
    const pid = document.getElementById('participant-select').value;
    const list = sessions.filter((s) => s.participant_id === pid);
    document.getElementById('participant-sessions').innerHTML = sessionsSummaryTable(list);
    document.getElementById('participant-narrative').classList.add('hidden');
  }

  function showConditionSessions() {
    const cond = document.getElementById('condition-select').value;
    const list = sessions.filter((s) => s.condition === cond);
    document.getElementById('condition-sessions').innerHTML = sessionsSummaryTable(list);
    document.getElementById('condition-narrative').classList.add('hidden');
  }

  document.getElementById('participant-select').addEventListener('change', showParticipantSessions);
  document.getElementById('condition-select').addEventListener('change', showConditionSessions);

  function sessionsSummaryTable(list) {
    if (list.length === 0) return '<p class="status-text">no sessions.</p>';
    const rows = list.map((s) => `
      <tr>
        <td>${s.condition}</td><td>${s.participant_id}</td>
        <td class="num">${durationLabel(s.duration_s)}</td>
        <td class="num">${fmt(s.mean_hr, 1)}</td>
        <td class="num">${fmt(s.sdnn, 1)}</td>
        <td class="num">${fmt(s.rmssd, 1)}</td>
        <td class="num">${s.analyzable && s.alpha1 !== null ? fmt(s.alpha1, 3) : 'n/a'}</td>
      </tr>`).join('');
    return `<table>
      <thead><tr><th>condition</th><th>participant</th><th>duration</th><th>hr</th><th>sdnn</th><th>rmssd</th><th>alpha1</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  async function loadParticipantNarrative(force) {
    const pid = document.getElementById('participant-select').value;
    if (!pid) return;
    const list = sessions.filter((s) => s.participant_id === pid);
    document.getElementById('participant-sessions').innerHTML = sessionsSummaryTable(list);

    const box = document.getElementById('participant-narrative');
    box.classList.remove('hidden');
    box.textContent = 'generating…';
    try {
      const url = `/api/participants/${encodeURIComponent(pid)}/narrative` + (force ? '?refresh=true' : '');
      const data = await getJson(url);
      box.textContent = data.narrative;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${data.cached ? 'cached' : 'generated'} · ${data.model} · ${data.generated_at}`;
      box.appendChild(meta);
    } catch (err) {
      box.textContent = err.message;
    }
  }

  async function loadConditionNarrative(force) {
    const cond = document.getElementById('condition-select').value;
    if (!cond) return;
    const list = sessions.filter((s) => s.condition === cond);
    document.getElementById('condition-sessions').innerHTML = sessionsSummaryTable(list);

    const box = document.getElementById('condition-narrative');
    box.classList.remove('hidden');
    box.textContent = 'generating…';
    try {
      const url = `/api/conditions/${encodeURIComponent(cond)}/narrative` + (force ? '?refresh=true' : '');
      const data = await getJson(url);
      box.textContent = data.narrative;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${data.cached ? 'cached' : 'generated'} · ${data.model} · ${data.generated_at}`;
      box.appendChild(meta);
    } catch (err) {
      box.textContent = err.message;
    }
  }

  document.getElementById('participant-narrative-btn').addEventListener('click', () => loadParticipantNarrative(false));
  document.getElementById('participant-refresh-btn').addEventListener('click', () => loadParticipantNarrative(true));
  document.getElementById('condition-narrative-btn').addEventListener('click', () => loadConditionNarrative(false));
  document.getElementById('condition-refresh-btn').addEventListener('click', () => loadConditionNarrative(true));

  // --- upload / rescan ----------------------------------------------------

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const scanStatus = document.getElementById('scan-status');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) uploadFiles(fileInput.files);
    fileInput.value = '';
  });

  async function uploadFiles(fileList) {
    const formData = new FormData();
    Array.from(fileList).forEach((f) => formData.append('files', f));
    scanStatus.textContent = 'uploading…';
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      scanStatus.textContent = `saved ${data.saved.length} file(s), analyzed ${data.scanned} session(s).` +
        (data.errors.length ? ` ${data.errors.length} error(s): ${data.errors.map((e) => e.file_name).join(', ')}` : '');
      await refreshAll();
    } catch (err) {
      scanStatus.textContent = 'upload failed: ' + err.message;
    }
  }

  document.getElementById('rescan-btn').addEventListener('click', async () => {
    scanStatus.textContent = 'scanning…';
    try {
      const res = await fetch('/api/rescan', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      scanStatus.textContent = `analyzed ${data.scanned} session(s).` +
        (data.errors.length ? ` ${data.errors.length} error(s): ${data.errors.map((e) => e.file_name).join(', ')}` : '') +
        (data.pruned.length ? ` removed ${data.pruned.length} stale entr${data.pruned.length === 1 ? 'y' : 'ies'}.` : '');
      await refreshAll();
    } catch (err) {
      scanStatus.textContent = 'rescan failed: ' + err.message;
    }
  });

  // --- init ----------------------------------------------------------

  async function refreshAll() {
    try {
      sessions = await getJson('/api/sessions');
    } catch (err) {
      sessions = [];
    }
    renderSessionsTable();
    populateSelects();
    await renderOverview();
  }

  refreshAll();
})();
