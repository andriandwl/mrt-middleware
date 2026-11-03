import { useMemo } from 'react';
import { Box, Button, Grid2 as Grid, Paper, Typography } from '@mui/material';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { useLiveChannel } from '../live/LiveContext';
import { tokens } from '../theme';
import { ErrorNotice, QualityDot, SeverityChip, mono } from '../components/common';
import { SEVERITY_LABEL, SOURCE_LABEL, fmtAgo, fmtTime, fmtValue, sortByLine } from '../format';

const SEVERITIES = ['critical', 'major', 'minor'];
const NON_LOG = 'alarm,device_event,status_change';

/** Terapkan event live ke daftar alarm aktif: raise menambah/mengganti, clear menghapus. */
export function applyAlarmEvent(list, rec) {
  if (!rec.alarmKey) return list;
  const rest = (list ?? []).filter((a) => a.alarmKey !== rec.alarmKey);
  return rec.state === 'active' ? [rec, ...rest] : rest;
}

function AlarmCounts({ alarms }) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  const bySource = { scada: 0, nms: 0, pids: 0 };
  (alarms ?? []).forEach((a) => {
    if (counts[a.severity] !== undefined) counts[a.severity] += 1;
    if (bySource[a.source] !== undefined) bySource[a.source] += 1;
  });
  return (
    <Paper sx={{ p: 2.5, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Typography variant="overline" component="h3" sx={{ color: 'text.secondary' }}>
        Alarm aktif saat ini
      </Typography>
      <Box sx={{ display: 'flex', gap: 3, mt: 1 }}>
        {SEVERITIES.map((s) => (
          <Box key={s}>
            <Typography
              sx={{ fontFamily: tokens.font.display, fontWeight: 600, fontSize: '2.6rem', lineHeight: 1, color: counts[s] ? tokens.signal[s] : tokens.signal.idle }}
            >
              {counts[s]}
            </Typography>
            <Typography sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>{SEVERITY_LABEL[s]}</Typography>
          </Box>
        ))}
      </Box>
      <Typography sx={{ ...mono, color: 'text.secondary', mt: 2 }}>
        SCADA {bySource.scada} · NMS {bySource.nms}
      </Typography>
      <Box sx={{ flexGrow: 1 }} />
      <Button component={Link} to="/event?view=active" size="small" sx={{ alignSelf: 'flex-start', mt: 2, px: 0 }}>
        Lihat daftar alarm aktif
      </Button>
    </Paper>
  );
}

function StationReadings({ station, rows }) {
  return (
    <Paper sx={{ p: 0, overflow: 'hidden' }}>
      <Box sx={{ px: 2, py: 1, borderBottom: `1px solid ${tokens.rule}`, display: 'flex', alignItems: 'baseline', gap: 1 }}>
        <Typography variant="h3" component="h3">
          {station}
        </Typography>
        <Typography sx={{ ...mono, color: 'text.secondary' }}>{rows.length} titik data</Typography>
      </Box>
      <Box sx={{ maxHeight: 360, overflowY: 'auto' }}>
        {rows.map((r) => (
          <Box
            key={`${r.assetId}|${r.metric}`}
            sx={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 1, px: 2, py: 1, borderBottom: `1px solid ${tokens.rule}`, '&:last-of-type': { borderBottom: 'none' } }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontSize: '0.85rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.assetId.replace(`${station}.`, '')} · {r.metric}
              </Typography>
              <Typography sx={{ ...mono, fontSize: '0.72rem', color: 'text.secondary' }}>
                {SOURCE_LABEL[r.source]} · {fmtAgo(r.sourceTs)}
              </Typography>
            </Box>
            <Box sx={{ textAlign: 'right' }}>
              <Typography sx={{ fontFamily: tokens.font.mono, fontWeight: 600, fontSize: '1rem' }}>{fmtValue(r)}</Typography>
              <QualityDot quality={r.quality} />
            </Box>
          </Box>
        ))}
      </Box>
    </Paper>
  );
}

export default function Overview() {
  const latest = useApi('/telemetry/latest');
  const alarms = useApi('/events/active', { limit: 1000 });
  const recent = useApi('/events', { category: NON_LOG, limit: 8 });

  useLiveChannel('telemetry', (rec) => {
    latest.setData((prev) => {
      const list = prev ? [...prev] : [];
      const i = list.findIndex((r) => r.assetId === rec.assetId && r.metric === rec.metric);
      if (i >= 0) list[i] = rec;
      else list.push(rec);
      return list;
    });
  });
  useLiveChannel('event', (rec) => {
    alarms.setData((prev) => applyAlarmEvent(prev, rec));
    if (rec.category !== 'log') recent.setData((prev) => [rec, ...(prev ?? [])].slice(0, 8));
  });

  const byStation = useMemo(() => {
    const m = new Map();
    (latest.data ?? []).forEach((r) => {
      if (!m.has(r.station)) m.set(r.station, []);
      m.get(r.station).push(r);
    });
    m.forEach((rows) => rows.sort((a, b) => `${a.assetId}${a.metric}`.localeCompare(`${b.assetId}${b.metric}`)));
    return sortByLine([...m.entries()], ([station]) => station);
  }, [latest.data]);

  const recentRows = recent.data ?? [];

  return (
    <>
      <ErrorNotice error={latest.error || alarms.error || recent.error} />
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid size={{ xs: 12, md: 4 }}>
          <AlarmCounts alarms={alarms.data} />
        </Grid>
        <Grid size={{ xs: 12, md: 8 }}>
          <Paper sx={{ p: 2.5, height: '100%' }}>
            <Typography variant="overline" component="h3" sx={{ color: 'text.secondary' }}>
              Event terbaru (tanpa log)
            </Typography>
            {recentRows.length === 0 && (
              <Typography sx={{ color: 'text.secondary', py: 2, fontSize: '0.9rem' }}>Belum ada event pada scope Anda.</Typography>
            )}
            {recentRows.map((e, i) => (
              <Box key={`${e.sourceTs}-${e.assetId}-${i}`} sx={{ display: 'grid', gridTemplateColumns: '64px 80px 1fr', alignItems: 'center', gap: 1.5, py: 0.6 }}>
                <Typography sx={{ ...mono, color: 'text.secondary' }}>{fmtTime(e.sourceTs)}</Typography>
                <SeverityChip severity={e.severity} />
                <Typography sx={{ fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <b>{e.station}</b> · {e.assetId} — {e.message}
                </Typography>
              </Box>
            ))}
          </Paper>
        </Grid>
      </Grid>

      <Typography variant="overline" component="h3" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>
        Nilai terkini per stasiun
      </Typography>
      {!latest.loading && byStation.length === 0 && (
        <Paper sx={{ p: 3, color: 'text.secondary' }}>Belum ada telemetri dalam 24 jam terakhir pada scope Anda.</Paper>
      )}
      <Grid container spacing={2}>
        {byStation.map(([station, rows]) => (
          <Grid key={station} size={{ xs: 12, md: 6, lg: 4 }}>
            <StationReadings station={station} rows={rows} />
          </Grid>
        ))}
      </Grid>
    </>
  );
}
