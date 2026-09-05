/**
 * Reference instrument catalogue, separate from watchlist and observations.
 *
 * Search reads this in-memory/cache-backed catalogue. Refresh is an explicit
 * background operation and never runs on a keystroke or enters ingestion.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalizeSymbol, venueOf } from './symbols.js';

const DEFAULT_NSE_URL = 'https://archives.nseindia.com/content/equities/EQUITY_L.csv';
const DEFAULT_BSE_URL = 'https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w';
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 20;

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      values.push(value.trim());
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values;
}

function parseNseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((header) => header.toUpperCase());
  const symbolIndex = headers.indexOf('SYMBOL');
  const nameIndex = headers.indexOf('NAME OF COMPANY');
  const seriesIndex = headers.indexOf('SERIES');
  const isinIndex = headers.indexOf('ISIN NUMBER');
  if (symbolIndex < 0 || nameIndex < 0) return [];

  return lines.slice(1).flatMap((line) => {
    const columns = parseCsvLine(line);
    if (seriesIndex >= 0 && columns[seriesIndex] !== 'EQ') return [];
    const symbol = columns[symbolIndex];
    const name = columns[nameIndex];
    try {
      return symbol && name
        ? [{ symbol: canonicalizeSymbol(symbol), name, exchange: 'NSE', series: columns[seriesIndex] ?? 'EQ', isin: columns[isinIndex] || null }]
        : [];
    } catch {
      return [];
    }
  });
}

function parseBsePayload(body) {
  const rows = Array.isArray(body) ? body : body?.Table ?? body?.data ?? body?.Data ?? [];
  return rows.flatMap((row) => {
    const symbol = row.Symbol ?? row.symbol ?? row.Scrip_Id ?? row.scrip_id ?? row.ScripID ?? row.scripId;
    const name = row.Scrip_Name ?? row.scrip_name ?? row.ScripName ?? row.NAME ?? row.name;
    const series = row.Group ?? row.group ?? row.Series ?? row.series ?? 'EQ';
    if (!symbol || !name || !['EQ', 'A', 'B'].includes(String(series).toUpperCase())) return [];
    try {
      const code = String(symbol).trim().toUpperCase().replace(/\.BO$/, '');
      return [{
        symbol: canonicalizeSymbol(`${code}.BO`),
        name: String(name).trim(),
        exchange: 'BSE',
        series: String(series).trim(),
        isin: row.ISIN ?? row.isin ?? null,
      }];
    } catch {
      return [];
    }
  });
}

function dedupe(records) {
  const bySymbol = new Map();
  for (const record of records) {
    if (!record?.symbol || !record?.name) continue;
    bySymbol.set(record.symbol, {
      symbol: record.symbol,
      name: record.name,
      exchange: record.exchange ?? venueOf(record.symbol),
      series: record.series ?? 'EQ',
      isin: record.isin ?? null,
    });
  }
  return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function rank(record, query) {
  const symbol = record.symbol.toLowerCase();
  const name = record.name.toLowerCase();
  const folded = query.toLowerCase();
  if (symbol === folded) return 0;
  if (symbol.startsWith(folded)) return 1;
  if (name.startsWith(folded)) return 2;
  if (name.includes(folded)) return 3;
  if (symbol.includes(folded)) return 4;
  return Number.POSITIVE_INFINITY;
}

export function createInstrumentCatalogue({
  source,
  cachePath,
  fetcher = fetch,
  nseUrl = DEFAULT_NSE_URL,
  bseUrl = DEFAULT_BSE_URL,
  initialRecords = [],
} = {}) {
  let records = dedupe(
    [...(source?.getSymbols?.() ?? []), ...initialRecords].map((entry) => ({
      ...entry,
      exchange: entry.exchange ?? venueOf(entry.symbol),
      series: entry.series ?? 'EQ',
    })),
  );
  let refreshing = null;

  async function loadCache() {
    if (!cachePath) return;
    try {
      const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      records = dedupe([...records, ...(cached.instruments ?? cached ?? [])]);
    } catch {
      // A missing or corrupt cache falls back to the active source's featured list.
    }
  }

  async function fetchText(url) {
    const response = await fetcher(url, {
      headers: { Accept: 'text/csv, application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`catalogue refresh failed (${response.status})`);
    return response;
  }

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const next = [];
      try {
        const response = await fetchText(nseUrl);
        next.push(...parseNseCsv(await response.text()));
      } catch {
        // Keep the last good catalogue when the official source is unavailable.
      }
      try {
        const response = await fetchText(bseUrl);
        const contentType = response.headers.get?.('content-type') ?? '';
        next.push(...(contentType.includes('json') ? parseBsePayload(await response.json()) : parseNseCsv(await response.text())));
      } catch {
        // BSE availability must not make NSE search or the app fail.
      }
      if (next.length > 0) {
        records = dedupe(next);
        if (cachePath) {
          await fs.mkdir(path.dirname(cachePath), { recursive: true });
          await fs.writeFile(cachePath, JSON.stringify({ updatedAt: Date.now(), instruments: records }, null, 2));
        }
      }
      return { count: records.length };
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  function search(query, limit = DEFAULT_LIMIT) {
    const folded = String(query ?? '').trim().toLowerCase();
    if (!folded) return [];
    return records
      .map((record) => ({ record, order: rank(record, folded) }))
      .filter(({ order }) => Number.isFinite(order))
      .sort((a, b) => a.order - b.order || a.record.name.localeCompare(b.record.name))
      .slice(0, limit)
      .map(({ record }) => ({ ...record }));
  }

  return {
    loadCache,
    refresh,
    search,
    stats: () => ({ count: records.length, refreshing: refreshing !== null }),
  };
}

export const __testing = { parseCsvLine, parseNseCsv, parseBsePayload, dedupe, rank };
