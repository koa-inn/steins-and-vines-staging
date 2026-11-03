'use strict';

var read = require('../lib/batch-pg-read');
var parse = read.parseCardFacts;

describe('parseCardFacts', function () {
  it('parses numbers and defaults strings', function () {
    expect(parse('{"abv":4.8,"ibu":32,"batch_size_l":28}')).toEqual({ abv: 4.8, ibu: 32, batch_size_l: 28, juice: '', yeast: '' });
  });
  it('coerces numeric strings and nulls zero, negative, non-finite', function () {
    expect(parse('{"abv":"5.1"}').abv).toBe(5.1);
    expect(parse('{"abv":0}').abv).toBeNull();
    expect(parse('{"abv":-2,"ibu":"x","batch_size_l":null}')).toMatchObject({ abv: null, ibu: null, batch_size_l: null });
  });
  it('picks juice and yeast by cf_type / cf_subcategory', function () {
    var snap = JSON.stringify({ ingredients: [
      { item_name: 'Apple Juice 23L', cf_type: 'Juice' },
      { item_name: 'Cider Yeast M02', cf_subcategory: 'Yeast' }
    ] });
    var r = parse(snap);
    expect(r.juice).toBe('Apple Juice 23L');
    expect(r.yeast).toBe('Cider Yeast M02');
  });
  it('treats Fruit type and Apple Concentrate subcategory as juice', function () {
    expect(parse('{"ingredients":[{"item_name":"Pears","cf_type":"Fruit"}]}').juice).toBe('Pears');
    expect(parse('{"ingredients":[{"item_name":"AC","cf_subcategory":"Apple Concentrate"}]}').juice).toBe('AC');
  });
  it('never matches on item_name', function () {
    var r = parse('{"ingredients":[{"item_name":"Apple Yeast","cf_type":"Hops"}]}');
    expect(r.juice).toBe('');
    expect(r.yeast).toBe('');
  });
  it('first match wins and names are capped to 80', function () {
    var long = new Array(100).join('x');
    var r = parse(JSON.stringify({ ingredients: [
      { item_name: long, cf_type: 'Juice' }, { item_name: 'Second', cf_type: 'Juice' },
      { item_name: 'Y1', cf_type: 'Yeast' }, { item_name: 'Y2', cf_type: 'Yeast' }
    ] }));
    expect(r.juice.length).toBe(80);
    expect(r.yeast).toBe('Y1');
  });
  it('is tolerant of junk', function () {
    ['not json', '', '[]', '{"ingredients":"x"}', 'null'].forEach(function (t) {
      expect(parse(t)).toEqual({ abv: null, batch_size_l: null, ibu: null, juice: '', yeast: '' });
    });
  });
  it('exposes exactly the whitelisted keys', function () {
    expect(Object.keys(parse('{"ingredients":[{"item_name":"a","cf_type":"Juice"}]}')).sort())
      .toEqual(['abv', 'batch_size_l', 'ibu', 'juice', 'yeast']);
  });
});

describe('getDashboardCardFacts', function () {
  it('maps rows through the parser with batch_id', async function () {
    var client = { query: jest.fn().mockResolvedValue({ rows: [{ batch_id: 'SV-B-000001', recipe_snapshot: '{"abv":5}' }] }) };
    var out = await read.getDashboardCardFacts(client);
    expect(out).toEqual([{ batch_id: 'SV-B-000001', abv: 5, ibu: null, batch_size_l: null, juice: '', yeast: '' }]);
    expect(client.query.mock.calls[0][0]).toMatch(/status in \('primary', 'secondary'\)/);
  });
});
