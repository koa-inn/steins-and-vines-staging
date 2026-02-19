(function () {
  'use strict';

  var batchId = '';
  var batchToken = '';
  var batchData = null;
  var apiUrl = '';

  // Safely extract YYYY-MM-DD from any date value (ISO string, Date object, etc.)
  function toDateStr(val) {
    if (!val) return '';
    return String(val).substring(0, 10);
  }

  function init() {
    apiUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.ADMIN_API_URL) || '';
    if (!apiUrl) { showError('Configuration error'); return; }

    var params = new URLSearchParams(window.location.search);
    batchId = params.get('id') || '';
    batchToken = params.get('token') || '';

    if (!batchId || !batchToken) {
      showError();
      return;
    }

    loadBatch();
    startAutoRefresh();
  }

  function loadBatch() {
    var url = apiUrl + '?action=get_batch_public&batch_id=' + encodeURIComponent(batchId) + '&token=' + encodeURIComponent(batchToken);
    fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.ok) { showError(data.message); return; }
        batchData = data.data;
        renderBatch(batchData);
      })
      .catch(function (err) { showError(err.message); });
  }

  function renderBatch(data) {
    var b = data.batch;
    var tasks = data.tasks || [];
    var readings = data.plato_readings || [];
    var history = data.vessel_history || [];

    document.getElementById('batch-loading').style.display = 'none';
    document.getElementById('batch-content').style.display = '';

    // Hero
    var statusColors = { primary: 'primary', secondary: 'secondary', complete: 'complete', disabled: 'disabled' };
    var statusLabels = { primary: 'Primary Fermentation', secondary: 'Secondary Fermentation', complete: 'Complete', disabled: 'Disabled' };
    var status = String(b.status || '').toLowerCase();
    var badge = document.getElementById('batch-status-badge');
    badge.textContent = statusLabels[status] || status;
    badge.className = 'batch-hero-status batch-hero-status--' + (statusColors[status] || 'gray');

    document.getElementById('batch-title').textContent = b.batch_id;
    document.getElementById('batch-product').textContent = b.product_name || '';
    document.getElementById('batch-customer').textContent = b.customer_name || '';
    document.getElementById('batch-start-date').textContent = b.start_date ? 'Started: ' + toDateStr(b.start_date) : '';
    document.getElementById('batch-vessel').textContent = b.vessel_id || '—';
    document.getElementById('batch-shelf').textContent = b.shelf_id || '—';
    document.getElementById('batch-bin').textContent = b.bin_id || '—';

    // Tasks
    renderTasks(tasks);

    // Plato readings
    renderPlatoReadings(readings, b.start_date);

    // Notes
    if (b.notes) {
      document.getElementById('batch-notes-card').style.display = '';
      document.getElementById('batch-notes').textContent = b.notes;
    }

    // Vessel history
    if (history.length > 0) {
      document.getElementById('batch-history-card').style.display = '';
      renderVesselHistory(history);
    }
  }

  function renderTasks(tasks) {
    var container = document.getElementById('batch-tasks-list');
    if (!tasks.length) { container.innerHTML = '<p class="batch-empty">No tasks scheduled.</p>'; return; }

    var todayStr = new Date().toISOString().substring(0, 10);
    var html = '';

    tasks.forEach(function (t) {
      var done = String(t.completed).toUpperCase() === 'TRUE';
      var isPkg = String(t.is_packaging).toUpperCase() === 'TRUE';
      var isTransfer = String(t.is_transfer).toUpperCase() === 'TRUE';
      var dueLabel = t.due_date ? toDateStr(t.due_date) : (isPkg ? 'TBD' : '—');
      var overdue = !done && t.due_date && toDateStr(t.due_date) < todayStr;

      var cls = 'batch-task';
      if (done) cls += ' batch-task--done';
      if (overdue) cls += ' batch-task--overdue';

      html += '<div class="' + cls + '">';
      html += '<label class="batch-task-label">';
      html += '<input type="checkbox" class="batch-task-checkbox" data-task-id="' + t.task_id + '" ' + (done ? 'checked' : '') + '>';
      html += '<span class="batch-task-title">' + (t.title || 'Step ' + t.step_number) + '</span>';
      if (isTransfer) html += '<span class="batch-badge batch-badge--transfer">Transfer</span>';
      if (isPkg) html += '<span class="batch-badge batch-badge--pkg">Packaging</span>';
      html += '</label>';
      html += '<span class="batch-task-due">' + dueLabel + '</span>';
      if (t.description) html += '<p class="batch-task-desc">' + t.description + '</p>';
      html += '</div>';
    });

    container.innerHTML = html;

    container.querySelectorAll('.batch-task-checkbox').forEach(function (cb) {
      cb.addEventListener('change', function () {
        toggleTask(cb.getAttribute('data-task-id'), cb.checked);
      });
    });
  }

  function toggleTask(taskId, completed) {
    var payload = {
      action: 'update_batch_task',
      batch_token: batchToken,
      batch_id: batchId,
      task_id: taskId,
      updates: { completed: completed }
    };

    fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data.ok) { showToast('Failed: ' + (data.message || data.error), 'error'); return; }
      showToast('Task ' + (completed ? 'completed' : 'unchecked'), 'success');
      loadBatch();
    })
    .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
  }

  function renderPlatoReadings(readings, startDate) {
    var chartEl = document.getElementById('batch-plato-chart');
    var listEl = document.getElementById('batch-plato-list');

    if (!readings || readings.length === 0) {
      chartEl.innerHTML = '';
      listEl.innerHTML = '<p class="batch-empty">No readings yet.</p>';
      return;
    }

    // Chart
    if (readings.length >= 2) {
      chartEl.innerHTML = renderPlatoChart(readings, startDate);
    } else {
      chartEl.innerHTML = '';
    }

    // Table
    var html = '<table class="batch-readings-table"><thead><tr><th>Date</th><th>&deg;P</th><th>Notes</th></tr></thead><tbody>';
    readings.slice().reverse().forEach(function (r) {
      html += '<tr><td>' + toDateStr(r.timestamp) + '</td><td>' + r.degrees_plato + '</td><td>' + (r.notes || '') + '</td></tr>';
    });
    html += '</tbody></table>';
    listEl.innerHTML = html;
  }

  function renderPlatoChart(readings, startDate) {
    var W = 400, H = 150, PAD = 30;
    var start = startDate ? new Date(startDate) : new Date(readings[0].timestamp);

    var points = readings.map(function (r) {
      var d = new Date(r.timestamp);
      var day = Math.round((d - start) / (1000 * 60 * 60 * 24));
      return { day: day, plato: Number(r.degrees_plato) };
    });

    var maxDay = Math.max.apply(null, points.map(function (p) { return p.day; })) || 1;
    var maxPlato = Math.max.apply(null, points.map(function (p) { return p.plato; })) || 1;
    var minPlato = Math.min.apply(null, points.map(function (p) { return p.plato; }));
    var range = maxPlato - minPlato || 1;

    var polyPoints = points.map(function (p) {
      var x = PAD + ((p.day / maxDay) * (W - PAD * 2));
      var y = H - PAD - (((p.plato - minPlato) / range) * (H - PAD * 2));
      return x + ',' + y;
    }).join(' ');

    var dots = points.map(function (p) {
      var x = PAD + ((p.day / maxDay) * (W - PAD * 2));
      var y = H - PAD - (((p.plato - minPlato) / range) * (H - PAD * 2));
      return '<circle cx="' + x + '" cy="' + y + '" r="3" fill="#5b7f3b"/>';
    }).join('');

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="batch-plato-svg">';
    svg += '<line x1="' + PAD + '" y1="' + (H - PAD) + '" x2="' + (W - PAD) + '" y2="' + (H - PAD) + '" stroke="#ccc"/>';
    svg += '<line x1="' + PAD + '" y1="' + PAD + '" x2="' + PAD + '" y2="' + (H - PAD) + '" stroke="#ccc"/>';
    svg += '<text x="' + PAD + '" y="' + (H - 5) + '" font-size="10" fill="#999">Day 0</text>';
    svg += '<text x="' + (W - PAD) + '" y="' + (H - 5) + '" font-size="10" fill="#999" text-anchor="end">Day ' + maxDay + '</text>';
    svg += '<text x="5" y="' + (PAD + 4) + '" font-size="10" fill="#999">' + maxPlato.toFixed(1) + '</text>';
    svg += '<text x="5" y="' + (H - PAD) + '" font-size="10" fill="#999">' + minPlato.toFixed(1) + '</text>';
    svg += '<polyline points="' + polyPoints + '" fill="none" stroke="#5b7f3b" stroke-width="2"/>';
    svg += dots;
    svg += '</svg>';
    return svg;
  }

  function renderVesselHistory(history) {
    var container = document.getElementById('batch-vessel-history');
    var html = '';
    history.forEach(function (h) {
      html += '<div class="batch-vh-entry">';
      html += '<strong>' + toDateStr(h.transferred_at) + '</strong> ';
      html += 'V:' + (h.vessel_id || '?') + ' S:' + (h.shelf_id || '?') + ' B:' + (h.bin_id || '?');
      if (h.notes) html += ' — ' + h.notes;
      html += '</div>';
    });
    container.innerHTML = html;
  }

  // --- Plato submission ---

  var platoBtn = null;
  function bindPlatoSubmit() {
    platoBtn = document.getElementById('plato-add-btn');
    if (!platoBtn) return;
    platoBtn.addEventListener('click', function () {
      var val = parseFloat(document.getElementById('plato-value').value);
      if (isNaN(val) || val < 0 || val > 40) { showToast('Enter a valid Plato value (0-40)', 'error'); return; }

      var payload = {
        action: 'add_plato_reading',
        batch_token: batchToken,
        batch_id: batchId,
        degrees_plato: val,
        notes: document.getElementById('plato-notes').value
      };

      fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload)
      })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.ok) { showToast('Failed: ' + (data.message || data.error), 'error'); return; }
        showToast('Reading recorded', 'success');
        document.getElementById('plato-value').value = '';
        document.getElementById('plato-notes').value = '';
        loadBatch();
      })
      .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
    });
  }

  // --- Toast ---

  function showToast(message, type) {
    var container = document.getElementById('batch-toast-container');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'batch-toast batch-toast--' + (type || 'info');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () {
      toast.classList.add('removing');
      setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 200);
    }, 3000);
  }

  function showError(msg) {
    document.getElementById('batch-loading').style.display = 'none';
    var errEl = document.getElementById('batch-error');
    errEl.style.display = '';
    if (msg) errEl.querySelector('p').textContent = msg;
  }

  function startAutoRefresh() {
    setInterval(function () { loadBatch(); }, 60 * 1000);
  }

  document.addEventListener('DOMContentLoaded', function () {
    init();
    bindPlatoSubmit();
  });
})();
