const timeFmt = new Intl.DateTimeFormat('id-ID', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'Asia/Jakarta',
});
const dateTimeFmt = new Intl.DateTimeFormat('id-ID', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'Asia/Jakarta',
});

export const fmtTime = (v) => (v ? timeFmt.format(new Date(v)) : '—');
export const fmtDateTime = (v) => (v ? dateTimeFmt.format(new Date(v)) : '—');

export function fmtValue(row) {
  // Boolean dari SCADA disimpan sebagai valueNum 1/0 + valueText 'true'/'false'
  if (row.valueText === 'true') return 'Ya';
  if (row.valueText === 'false') return 'Tidak';
  if (row.valueNum !== null && row.valueNum !== undefined) {
    const n = Number(row.valueNum);
    const s = Math.abs(n) >= 1000 ? n.toLocaleString('id-ID', { maximumFractionDigits: 1 }) : n.toLocaleString('id-ID', { maximumFractionDigits: 2 });
    return row.unit ? `${s} ${row.unit}` : s;
  }
  return row.valueText ?? '—';
}

export function fmtAgo(v) {
  if (!v) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(v).getTime()) / 1000));
  if (s < 60) return `${s} dtk lalu`;
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  return `${Math.floor(s / 3600)} jam lalu`;
}

/** Urutan stasiun sepanjang jalur (selatan → utara); OCC & kode lain di belakang. */
export const STATION_ORDER = ['LBB', 'FTM', 'CPR', 'HJN', 'BLA', 'BLM', 'ASN', 'SNY', 'IST', 'BNH', 'STB', 'DKA', 'BHI', 'OCC'];

export function sortByLine(list, getStation) {
  const rank = (s) => {
    const i = STATION_ORDER.indexOf(s);
    return i === -1 ? STATION_ORDER.length : i;
  };
  return [...list].sort((a, b) => rank(getStation(a)) - rank(getStation(b)) || String(getStation(a)).localeCompare(String(getStation(b))));
}

export const SOURCE_LABEL ={ scada: 'Facility SCADA', nms: 'DTS / NMS', pids: 'PIDS / PIDC' };
export const SEVERITY_LABEL = { critical: 'Kritis', major: 'Mayor', minor: 'Minor', info: 'Info' };
export const STATE_LABEL = { active: 'Aktif', cleared: 'Selesai', info: 'Info' };
export const TRAIN_TYPE_LABEL = { arrival: 'Kedatangan', departure: 'Keberangkatan', delay: 'Keterlambatan', disruption: 'Gangguan' };
export const CONNECTOR_STATE_LABEL = {
  connected: 'Tersambung',
  connecting: 'Menyambung',
  disconnected: 'Terputus',
  error: 'Gagal',
  stopped: 'Berhenti',
  idle: 'Belum aktif',
};
