'use strict';

// Phase 86 Plan 15 - source-level assertions that server.js mounts the vessels routes and
// registers the 5-minute ops mirror sweep (D-10).

var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

describe('server.js ops mirror wiring', function () {
  test('mounts routes/vessels exactly once, after staff-access', function () {
    var mount = "app.use('/', require('./routes/vessels'));";
    expect(src.split(mount).length - 1).toBe(1);
    expect(src.indexOf(mount)).toBeGreaterThan(src.indexOf("require('./routes/staff-access')"));
  });

  test('requires lib/ops-mirror', function () {
    expect(src).toMatch(/require\('\.\/lib\/ops-mirror'\)/);
  });

  test('registers a 5-minute opsMirror.sweep() interval with error logging', function () {
    expect(src.split('opsMirror.sweep()').length - 1).toBe(1);
    var idx = src.indexOf('opsMirror.sweep()');
    var block = src.slice(idx, idx + 400);
    expect(block).toMatch(/log\.error\('\[ops-mirror\] sweep failed: '/);
    expect(block).toMatch(/5 \* 60 \* 1000/);
    expect(src).toContain("log.info('[ops-mirror] Ops mirror sweep registered: every 5 minutes');");
  });
});
