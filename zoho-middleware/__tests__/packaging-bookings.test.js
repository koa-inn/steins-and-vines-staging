'use strict';

var pb = require('../lib/packaging-bookings');

describe('packaging-bookings', function () {
  it('normEmail', function () {
    expect(pb.normEmail('  Ann@Example.COM ')).toBe('ann@example.com');
    expect(pb.normEmail(null)).toBe('');
  });

  it('vancouverDay uses Vancouver calendar day', function () {
    expect(pb.vancouverDay('2026-11-06T05:00:00.000Z')).toBe('2026-11-05');
    expect(pb.vancouverDay('bad')).toBe('');
  });

  it('packagingWindow', function () {
    expect(pb.packagingWindow(new Date('2026-11-03T20:00:00Z'))).toEqual({
      start: '2026-11-03', end: '2026-11-16',
      afterStart: '2026-11-02T00:00:00.000Z', beforeEnd: '2026-11-18T00:00:00.000Z'
    });
    expect(pb.packagingWindow(new Date('2026-11-04T06:30:00Z')).start).toBe('2026-11-03');
  });

  describe('matchBatch', function () {
    function c(id, due, ce, be) {
      return { batch_id: id, customer_email: ce || '', bottling_invite_email: be || '', packaging_due: due };
    }
    it('single match, case/trim insensitive', function () {
      expect(pb.matchBatch('ann@x.com', '2026-11-05', [c('A', null, 'ANN@x.com ')])).toBe('A');
    });
    it('matches bottling_invite_email', function () {
      expect(pb.matchBatch('ann@x.com', '2026-11-05', [c('B', null, '', 'ann@x.com')])).toBe('B');
    });
    it('closest due wins', function () {
      expect(pb.matchBatch('a@x.com', '2026-11-05', [c('A', '2026-11-12', 'a@x.com'), c('B', '2026-11-04', 'a@x.com')])).toBe('B');
    });
    it('tie -> null', function () {
      expect(pb.matchBatch('a@x.com', '2026-11-05', [c('A', '2026-11-03', 'a@x.com'), c('B', '2026-11-07', 'a@x.com')])).toBeNull();
    });
    it('both undated -> null; one dated wins', function () {
      expect(pb.matchBatch('a@x.com', '2026-11-05', [c('A', null, 'a@x.com'), c('B', null, 'a@x.com')])).toBeNull();
      expect(pb.matchBatch('a@x.com', '2026-11-05', [c('A', null, 'a@x.com'), c('B', '2026-11-09', 'a@x.com')])).toBe('B');
    });
    it('blank never matches blank', function () {
      expect(pb.matchBatch('', '2026-11-05', [c('A', null, '')])).toBeNull();
      expect(pb.matchBatch('  ', '2026-11-05', [c('A', null, '')])).toBeNull();
    });
  });

  describe('shapeBookings', function () {
    var ids = { bottlingId: 5904690, packagingId: 6028745 };
    var win = { start: '2026-11-03', end: '2026-11-16' };
    var cands = [{ batch_id: 'A', customer_email: 'ann@x.com', bottling_invite_email: '', packaging_due: null }];
    function bk(uid, start, extra) {
      return Object.assign({
        uid: uid, start: start, end: start, status: 'accepted',
        eventType: { id: 5904690 },
        attendees: [{ name: 'Ann', email: 'ann@x.com' }]
      }, extra || {});
    }
    it('filters, classifies, whitelists and sorts', function () {
      var raw = [
        bk('late', '2026-11-10T20:00:00Z'),
        bk('early', '2026-11-05T20:00:00Z', { eventType: undefined, eventTypeId: 6028745 }),
        bk('out', '2026-12-30T20:00:00Z'),
        bk('canc', '2026-11-06T20:00:00Z', { status: 'cancelled' }),
        bk('rej', '2026-11-06T20:00:00Z', { status: 'REJECTED' }),
        bk('long', '2026-11-07T20:00:00Z', { attendees: [{ name: new Array(200).join('x'), email: 'z@z.com' }] })
      ];
      var out = pb.shapeBookings(raw, ids, cands, win);
      expect(out.map(function (b) { return b.start; })).toEqual(['2026-11-05T20:00:00Z', '2026-11-07T20:00:00Z', '2026-11-10T20:00:00Z']);
      expect(out[0].kind).toBe('canning');
      expect(out[2].kind).toBe('bottling');
      expect(out[0].batch_id).toBe('A');
      expect(out[1].customer_name.length).toBe(80);
      // WR-04: the Cal.com uid (manage-page key), end and event_type_id are not sent to the browser.
      expect(Object.keys(out[0]).sort()).toEqual(['batch_id', 'customer_name', 'day', 'kind', 'start']);
      expect(JSON.stringify(out)).not.toMatch(/early|late|long|uid/);
      expect(JSON.stringify(out)).not.toContain('@');
    });

    it('CR-01: keeps a booking that already ended earlier today (first window day)', function () {
      var raw = [bk('morning', '2026-11-03T18:00:00Z', { end: '2026-11-03T19:00:00Z', status: 'accepted' })];
      var out = pb.shapeBookings(raw, ids, cands, win);
      expect(out).toHaveLength(1);
      expect(out[0].day).toBe('2026-11-03');
      expect(out[0].batch_id).toBe('A');
    });
  });

  it('cacheKey changes after invalidate', function () {
    var k = pb.cacheKey('2026-11-03');
    expect(k.indexOf('calcom:packaging-bookings:')).toBe(0);
    pb.invalidate();
    expect(pb.cacheKey('2026-11-03')).not.toBe(k);
  });
});
