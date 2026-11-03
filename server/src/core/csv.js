'use strict';

const fs = require('node:fs');

/**
 * Parser/penulis CSV sederhana (RFC 4180): mendukung kutip ganda, koma dan baris baru di dalam kutip.
 * Cukup untuk katalog tag; tidak perlu dependency tambahan.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);

  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

function readCsvFile(file) {
  return parseCsv(fs.readFileSync(file, 'utf8'));
}

const esc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** @param {string[]} columns @param {Record<string, unknown>[]} rows */
function toCsv(columns, rows) {
  return `${[columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n')}\n`;
}

module.exports = { parseCsv, readCsvFile, toCsv };
