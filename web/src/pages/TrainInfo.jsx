import { useState } from 'react';
import {
  Alert,
  Box,
  Grid2 as Grid,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useApi } from '../hooks/useApi';
import { useLiveChannel } from '../live/LiveContext';
import { EmptyRow, ErrorNotice, FilterSelect, PageTitle, mono } from '../components/common';
import { TRAIN_TYPE_LABEL, fmtDateTime, fmtTime, sortByLine } from '../format';
import { tokens } from '../theme';

const MAX_ROWS = 300;
const PLATFORM_LABEL = { 1: 'Peron 1', 2: 'Peron 2' };

function fmtDelay(sec) {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return 'Tepat waktu';
  return `+${Math.round(sec / 60)} mnt`;
}

function minutesUntil(ts) {
  const m = Math.round((new Date(ts).getTime() - Date.now()) / 60_000);
  if (m <= 0) return 'Tiba';
  return `${m} mnt`;
}

/** Satu baris kereta di papan: menit menuju kedatangan, tujuan, nomor perjalanan, keterlambatan. */
function BoardRow({ t }) {
  const eta = t.estimatedTs ?? t.scheduledTs;
  const late = (t.delaySec ?? 0) >= 60;
  const arrived = t.status === 'ARRIVED';
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '72px 1fr', alignItems: 'baseline', gap: 1, py: 0.5 }}>
      <Typography sx={{ fontFamily: tokens.font.display, fontWeight: 600, fontSize: '1.25rem', color: arrived ? tokens.signal.good : tokens.ink }}>
        {arrived ? 'Di peron' : minutesUntil(eta)}
      </Typography>
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: '0.85rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {t.direction}
        </Typography>
        <Typography title={`Perjalanan ${t.trainNo}`} sx={{ ...mono, fontSize: '0.72rem', color: 'text.secondary', whiteSpace: 'nowrap' }}>
          {fmtTime(eta).slice(0, 5)} ·{' '}
          <Box component="span" sx={{ color: late ? tokens.signal.major : tokens.signal.good }}>
            {late ? fmtDelay(t.delaySec) : 'Tepat'}
          </Box>
        </Typography>
      </Box>
    </Box>
  );
}

function StationBoard({ s }) {
  return (
    <Paper sx={{ overflow: 'hidden', height: '100%' }}>
      <Box sx={{ px: 2, py: 1, bgcolor: tokens.line, color: '#fff', display: 'flex', alignItems: 'baseline', gap: 1 }}>
        <Typography sx={{ fontFamily: tokens.font.display, fontWeight: 600, fontSize: '1.2rem', letterSpacing: '0.04em' }}>{s.station}</Typography>
      </Box>
      {s.disruptions.map((d) => (
        <Alert key={d.refId} severity="warning" icon={false} sx={{ borderRadius: 0, py: 0, fontSize: '0.8rem' }}>
          {d.message}
        </Alert>
      ))}
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
        {['1', '2'].map((p) => (
          <Box key={p} sx={{ px: 1.5, py: 1, borderRight: p === '1' ? `1px solid ${tokens.rule}` : 'none' }}>
            <Typography variant="overline" sx={{ color: 'text.secondary', lineHeight: 1.4 }}>
              {PLATFORM_LABEL[p]}
            </Typography>
            {(s.platforms[p] ?? []).length === 0 && <Typography sx={{ fontSize: '0.8rem', color: 'text.secondary', py: 0.5 }}>Tidak ada kereta</Typography>}
            {(s.platforms[p] ?? []).map((t) => (
              <BoardRow key={t.refId} t={t} />
            ))}
          </Box>
        ))}
      </Box>
    </Paper>
  );
}

export default function TrainInfo() {
  const [station, setStation] = useState('');
  const [type, setType] = useState('');
  const board = useApi('/train-info/board', { station }, { refreshMs: 10_000 });
  const info = useApi('/train-info', { station, type, limit: MAX_ROWS });

  useLiveChannel('train_info', (rec) => {
    if (station && rec.station !== station) return;
    if (type && rec.type !== type) return;
    info.setData((prev) => [rec, ...(prev ?? [])].slice(0, MAX_ROWS));
  });

  const boards = sortByLine(board.data ?? [], (s) => s.station);
  const rows = info.data ?? [];

  return (
    <>
      <PageTitle title="Info kereta">
        <FilterSelect label="Jenis" value={type} onChange={setType} options={Object.entries(TRAIN_TYPE_LABEL)} />
        <TextField
          size="small"
          label="Stasiun"
          placeholder="mis. LBB"
          value={station}
          onChange={(e) => setStation(e.target.value.toUpperCase())}
          sx={{ width: 120 }}
        />
      </PageTitle>
      <ErrorNotice error={board.error || info.error} />

      <Typography variant="overline" component="h3" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>
        Papan kedatangan · diperbarui tiap 10 detik
      </Typography>
      {!board.loading && boards.length === 0 && (
        <Paper sx={{ p: 3, mb: 3, color: 'text.secondary' }}>
          Belum ada perkiraan kedatangan. Papan terisi saat feed PIDS aktif dan kereta beroperasi (05.00–24.00 WIB).
        </Paper>
      )}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        {boards.map((s) => (
          <Grid key={s.station} size={{ xs: 12, sm: 6, lg: 4 }}>
            <StationBoard s={s} />
          </Grid>
        ))}
      </Grid>

      <Typography variant="overline" component="h3" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>
        Riwayat pesan PIDS
      </Typography>
      <Paper>
        <TableContainer sx={{ maxHeight: 480 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Diterima</TableCell>
                <TableCell>Stasiun</TableCell>
                <TableCell>Peron</TableCell>
                <TableCell>Perjalanan</TableCell>
                <TableCell>Tujuan</TableCell>
                <TableCell>Jenis</TableCell>
                <TableCell>Jadwal</TableCell>
                <TableCell>Perkiraan</TableCell>
                <TableCell>Selisih</TableCell>
                <TableCell>Pesan</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {!info.loading && rows.length === 0 && <EmptyRow colSpan={10}>Belum ada pesan dari PIDS.</EmptyRow>}
              {rows.map((r, i) => (
                <TableRow key={`${r.sourceTs}-${r.refId}-${r.station}-${i}`} hover>
                  <TableCell sx={{ ...mono, whiteSpace: 'nowrap' }}>{fmtDateTime(r.sourceTs)}</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{r.station}</TableCell>
                  <TableCell sx={{ fontFamily: tokens.font.display, fontWeight: 600, fontSize: '1.05rem' }}>{r.platform ?? '—'}</TableCell>
                  <TableCell sx={mono}>{r.trainNo ?? r.refId ?? '—'}</TableCell>
                  <TableCell>{r.direction ?? '—'}</TableCell>
                  <TableCell sx={{ color: r.type === 'disruption' ? tokens.signal.critical : 'inherit', fontWeight: r.type === 'disruption' ? 600 : 400 }}>
                    {TRAIN_TYPE_LABEL[r.type] ?? r.type}
                  </TableCell>
                  <TableCell sx={mono}>{fmtTime(r.scheduledTs)}</TableCell>
                  <TableCell sx={mono}>{fmtTime(r.estimatedTs)}</TableCell>
                  <TableCell sx={{ ...mono, color: r.delaySec >= 60 ? tokens.signal.major : 'inherit' }}>{fmtDelay(r.delaySec)}</TableCell>
                  <TableCell sx={{ maxWidth: 320 }}>{r.message ?? ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
    </>
  );
}
