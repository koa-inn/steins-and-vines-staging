// =============================================================================
// 12c-checkout-scheduling.js
// Timeslot calendar, slot rendering, and completion estimate helpers.
// Loaded before 12-checkout.js in the concat:js pipeline.
// =============================================================================

// Pure helpers — testable and reusable outside the DOMContentLoaded scope

// Returns the completion estimate text string, or null when the element should be hidden.
// Extracted from updateCompletionEstimate so the date math can be unit-tested independently.
function calcCompletionRange(items, timeslotValue) {
  var maxWeeks = 0;
  var hasTimeProp = false;
  items.forEach(function (item) {
    if (item.time) hasTimeProp = true;
    var weeks = parseInt(item.time, 10);
    if (!isNaN(weeks) && weeks > maxWeeks) maxWeeks = weeks;
  });

  if (maxWeeks === 0) {
    return hasTimeProp ? 'varies' : null;
  }

  var datePart = timeslotValue.split(' ')[0];
  var startDate = new Date(datePart + 'T00:00:00');
  if (isNaN(startDate.getTime())) return null;

  var weekStart = new Date(startDate);
  weekStart.setDate(weekStart.getDate() + (maxWeeks * 7));
  var weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  var opts = { month: 'long', day: 'numeric' };
  var startStr = weekStart.toLocaleDateString('en-US', opts);
  var endOpts = weekStart.getMonth() === weekEnd.getMonth() ? { day: 'numeric' } : opts;
  var endStr = weekEnd.toLocaleDateString('en-US', endOpts);
  var yearStr = weekEnd.getFullYear();

  return 'Estimated ready the week of ' + startStr + '\u2013' + endStr + ', ' + yearStr
    + ' (approximately ' + maxWeeks + ' week' + (maxWeeks !== 1 ? 's' : '')
    + ' from your appointment). This is an estimate \u2014 actual times may vary.';
}

function formatTimeslot(ts) {
  var parts = ts.split(' ');
  if (parts.length < 2) return ts;
  var d = new Date(parts[0] + 'T00:00:00');
  if (isNaN(d.getTime())) return ts;
  var day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return day + ' at ' + parts.slice(1).join(' ');
}

function loadTimeslots() {
  var container = document.getElementById('timeslot-groups'); if (!container) return;
  var items = getAllCartItems(); var hasOut = items.some(function (i) { return (i.stock || 0) === 0; });
  var cutoff = null; if (hasOut) { cutoff = new Date(); cutoff.setDate(cutoff.getDate() + 14); cutoff.setHours(0, 0, 0, 0); }
  container.innerHTML = '';
  if (hasOut) { var n = document.createElement('p'); n.className = 'timeslot-notice'; n.textContent = 'Some items need to be ordered. 2-week lead time required.'; container.appendChild(n); }

  var isK = document.body.classList.contains('kiosk-mode');
  if (isK && !hasOut && items.length > 0) {
    var sWrap = document.createElement('div'); sWrap.className = 'start-now-wrap';
    sWrap.innerHTML = '<p class="start-now-note">All items in stock \u2014 start now.</p><button type="button" class="btn start-now-btn">Start Now</button><p class="start-now-or">or choose a timeslot below</p>';
    var imm = document.createElement('input'); imm.type = 'radio'; imm.name = 'timeslot'; imm.value = 'Walk-in \u2014 Immediate'; imm.className = 'hidden';
    container.appendChild(imm);
    sWrap.querySelector('button').addEventListener('click', function () {
      imm.checked = true; this.classList.add('start-now-selected');
      container.querySelectorAll('input[name="timeslot"]:not([value="Walk-in \u2014 Immediate"])').forEach(function (r) { r.checked = false; });
      if (document.getElementById('completion-estimate')) document.getElementById('completion-estimate').classList.add('hidden');
    });
    container.appendChild(sWrap);
  }

  var cal = document.createElement('div'); cal.className = 'cal'; container.appendChild(cal);
  var slots = document.createElement('div'); slots.className = 'cal-slots'; container.appendChild(slots);
  var selD = null; var rIdx = 0; var now = new Date(); var mList = [];
  for (var m = 0; m < 4; m++) { var d = new Date(now.getFullYear(), now.getMonth() + m, 1); mList.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')); }
  var curM = 0; var cache = {};

  function render() {
    cal.innerHTML = ''; var ym = mList[curM]; var y = parseInt(ym.substring(0, 4)); var m = parseInt(ym.substring(5, 7)) - 1;
    var hdr = document.createElement('div'); hdr.className = 'cal-header';
    hdr.innerHTML = '<button type="button" class="cal-nav" ' + (curM === 0 ? 'disabled' : '') + '>\u2039</button>' +
      '<span class="cal-title">' + ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m] + ' ' + y + '</span>' +
      '<button type="button" class="cal-nav" ' + (curM === mList.length - 1 ? 'disabled' : '') + '>\u203A</button>';
    hdr.querySelectorAll('.cal-nav').forEach(function (b, i) { b.addEventListener('click', function () { if (i === 0) curM--; else curM++; render(); }); });
    cal.appendChild(hdr);
    var grid = document.createElement('div'); grid.className = 'cal-grid';
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(function (l) { var d = document.createElement('div'); d.className = 'cal-dow'; d.textContent = l; grid.appendChild(d); });
    cal.appendChild(grid);

    var mw = (typeof SHEETS_CONFIG !== 'undefined') ? (SHEETS_CONFIG.MIDDLEWARE_URL || '') : '';
    fetch(mw + '/api/bookings/availability?year=' + y + '&month=' + (m + 1)).then(function (r) { return r.json(); }).then(function (data) {
      grid.innerHTML = ''; ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(function (l) { var d = document.createElement('div'); d.className = 'cal-dow'; d.textContent = l; grid.appendChild(d); });
      var first = new Date(y, m, 1); var start = first.getDay(); var days = new Date(y, m + 1, 0).getDate();
      var today = new Date(); today.setHours(0, 0, 0, 0); var tStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
      for (var e = 0; e < start; e++) { var em = document.createElement('div'); em.className = 'cal-day cal-day--disabled'; grid.appendChild(em); }
      var avail = {}; (data.dates || []).forEach(function (d) { avail[d.date] = { available: true, slots: d.slots_count || 0 }; });
      for (var d = 1; d <= days; d++) {
        var ds = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        var c = document.createElement('button'); c.type = 'button'; c.className = 'cal-day'; c.textContent = d;
        var cd = new Date(ds + 'T00:00:00'); var past = cd < today; var info = avail[ds]; var hasS = !!(info && info.available); var cut = cutoff && cd < cutoff;
        if (ds === tStr) c.classList.add('cal-day--today'); if (ds === selD) c.classList.add('cal-day--selected');
        if (past || !hasS || cut) { c.classList.add('cal-day--disabled'); c.disabled = true; }
        else {
          c.classList.add('cal-day--available');
          if (info.slots > 0 && info.slots <= 3) { var b = document.createElement('span'); b.className = 'cal-day-spots'; b.textContent = info.slots + ' left'; c.appendChild(b); }
          (function (date) { c.addEventListener('click', function () { selD = date; render(); renderSlots(date); }); })(ds);
        }
        grid.appendChild(c);
      }
    }).catch(function (err) {
      console.error('[calendar] Failed to load availability:', err);
      grid.innerHTML = '<p class="calendar-error" style="grid-column:1/-1">Unable to load availability. Please refresh or call us at (604) 567-4565.</p>';
    });
  }

  function renderSlots(ds) {
    slots.innerHTML = '<p>Loading times...</p>';
    var mw = (typeof SHEETS_CONFIG !== 'undefined') ? (SHEETS_CONFIG.MIDDLEWARE_URL || '') : '';
    fetch(mw + '/api/bookings/slots?date=' + ds).then(function (r) { return r.json(); }).then(function (data) {
      slots.innerHTML = '<h3>' + new Date(ds + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + '</h3>';
      var slotList = data.slots || [];
      if (slotList.length === 0) {
        slots.innerHTML += '<p class="calendar-empty">No available times for this date. Please select another day.</p>';
        return;
      }
      var fs = document.createElement('fieldset'); fs.className = 'timeslot-fieldset';
      var g = document.createElement('div'); g.className = 'cal-slots-grid';
      slotList.forEach(function (s) {
        var time = s.time || s; var id = 'ts-' + (rIdx++);
        var o = document.createElement('div'); o.className = 'timeslot-option';
        o.innerHTML = '<input type="radio" name="timeslot" id="' + id + '" value="' + ds + ' ' + time + '"><label for="' + id + '">' + time + '</label>';
        g.appendChild(o);
      });
      fs.appendChild(g); slots.appendChild(fs);
    }).catch(function (err) {
      console.error('[calendar] Failed to load slots:', err);
      slots.innerHTML = '<p class="calendar-error">Unable to load available times. Please refresh or call us at (604) 567-4565.</p>';
    });
  }
  render();
  container.addEventListener('change', function (e) {
    if (e.target.name === 'timeslot') {
      updateCompletionEstimate(e.target.value);
      var sn = container.querySelector('.start-now-btn'); if (sn && e.target.value !== 'Walk-in \u2014 Immediate') sn.classList.remove('start-now-selected');
      setTimeout(function () { var f = document.getElementById('reservation-form-section'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 600);
    }
  });
}

function updateCompletionEstimate(ts) {
  var el = document.getElementById('completion-estimate'); var txt = document.getElementById('completion-estimate-text');
  if (!el || !txt) return; var items = getAllCartItems(); if (items.length === 0) { el.classList.add('hidden'); return; }
  var res = calcCompletionRange(items, ts);
  if (res === null) el.classList.add('hidden'); else { txt.textContent = res; el.classList.remove('hidden'); }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    calcCompletionRange: calcCompletionRange,
    formatTimeslot: formatTimeslot,
    loadTimeslots: loadTimeslots,
    updateCompletionEstimate: updateCompletionEstimate
  };
}
