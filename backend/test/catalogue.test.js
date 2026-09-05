import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { createInstrumentCatalogue, __testing } = await import('../src/catalogue.js');
const { createApi } = await import('../src/api.js');
const { createDatabase } = await import('../src/db.js');
const { createSnapshotLog } = await import('../src/snapshot-log.js');
const { createWatchlist } = await import('../src/watchlist.js');

const source = {
  getSymbols: () => [{ symbol: 'RELIANCE', name: 'Reliance Industries' }],
};

test('NSE catalogue parsing keeps only EQ instruments and preserves metadata', () => {
  const csv = [
    'SYMBOL,NAME OF COMPANY,SERIES,ISIN NUMBER',
    'TCS,Tata Consultancy Services,EQ,INE467B01029',
    'NIFTYBEES,Nippon India ETF Nifty BeES,BE,INF204KB17I5',
  ].join('\n');

  assert.deepEqual(__testing.parseNseCsv(csv), [
    {
      symbol: 'TCS',
      name: 'Tata Consultancy Services',
      exchange: 'NSE',
      series: 'EQ',
      isin: 'INE467B01029',
    },
  ]);
});

test('local search ranks exact symbol, symbol prefix, name prefix, then contains', () => {
  const csvRecords = [
    { symbol: 'HDFC', name: 'HDFC Limited', exchange: 'NSE' },
    { symbol: 'HDFCBANK', name: 'HDFC Bank', exchange: 'NSE' },
    { symbol: 'ABC', name: 'HDFC Asset Management', exchange: 'NSE' },
    { symbol: 'RELIANCE', name: 'Reliance Industries', exchange: 'NSE' },
  ];
  const catalogue = createInstrumentCatalogue({ source, initialRecords: csvRecords });
  assert.deepEqual(catalogue.search('hdfc').map((record) => record.symbol), ['HDFC', 'HDFCBANK', 'ABC']);
});

test('catalogue refresh is cached and does not run on search', async () => {
  let calls = 0;
  const catalogue = createInstrumentCatalogue({
    source,
    nseUrl: 'https://catalogue.test/nse',
    bseUrl: 'https://catalogue.test/bse',
    fetcher: async (url) => {
      calls += 1;
      return {
        ok: true,
        async text() {
          return url.endsWith('/nse')
            ? 'SYMBOL,NAME OF COMPANY,SERIES\nINFY,Infosys,EQ'
            : '';
        },
        headers: { get: () => 'text/csv' },
      };
    },
  });

  assert.deepEqual(catalogue.search('infy'), []);
  await catalogue.refresh();
  assert.equal(calls, 2);
  assert.equal(catalogue.search('infy')[0].symbol, 'INFY');
  assert.equal(calls, 2, 'search did not call the provider');
});

test('unsupported BSE rows without a trading symbol are ignored', () => {
  assert.deepEqual(
    __testing.parseBsePayload([{ Scrip_cd: '500325', Scrip_Name: 'Reliance Industries', Group: 'A' }]),
    [],
  );
});

test('API search reads the local catalogue without calling source discovery', async () => {
  const db = createDatabase(':memory:');
  const snapshotLog = createSnapshotLog(db);
  const watchlist = createWatchlist(db);
  let remoteSearchCalls = 0;
  const source = {
    name: 'test',
    describe: () => ({ name: 'test', kind: 'synthetic', alwaysOpen: true, delayMs: 0 }),
    getSymbols: () => [],
    searchSymbols: async () => {
      remoteSearchCalls += 1;
      return [];
    },
  };
  const catalogue = createInstrumentCatalogue({
    source,
    initialRecords: [{ symbol: 'TCS', name: 'Tata Consultancy Services', exchange: 'NSE' }],
  });
  const app = express();
  app.use(express.json());
  app.use('/api', createApi({ snapshotLog, watchlist, source, instrumentCatalogue: catalogue }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/symbols/search?q=tata`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.results[0].symbol, 'TCS');
    assert.equal(remoteSearchCalls, 0);
  } finally {
    server.close();
    db.close();
  }
});