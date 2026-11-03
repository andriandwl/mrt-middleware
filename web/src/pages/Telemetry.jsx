import { useMemo, useState } from 'react';
import {
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
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
import CloseIcon from '@mui/icons-material/Close';
import { useApi } from '../hooks/useApi';
import { useLiveChannel } from '../live/LiveContext';
import { EmptyRow, ErrorNotice, FilterSelect, PageTitle, QualityDot, mono } from '../components/common';
import Sparkline from '../components/Sparkline';
import { SOURCE_LABEL, fmtDateTime, fmtTime, fmtValue } from '../format';
import { tokens } from '../theme';

function HistoryDialog({ row, onClose }) {
  const history = useApi(
    '/telemetry',
    { assetId: row?.assetId, metric: row?.metric, limit: 300 },
    { enabled: Boolean(row) },
  );
  useLiveChannel('telemetry', (rec) => {
    if (row && rec.assetId === row.assetId && rec.metric === row.metric) {
      history.setData((prev) => [rec, ...(prev ?? [])].slice(0, 300));
    }
  });
  const points = (history.data ?? [])
    .slice()
    .reverse()
    .map((r) => ({ t: r.sourceTs, v: r.valueNum === null ? NaN : Number(r.valueNum) }));

  return (
    <Dialog open={Boolean(row)} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ fontFamily: tokens.font.display, fontWeight: 600, pr: 6 }}>
        {row?.assetId} · {row?.metric}
        <IconButton aria-label="Tutup" onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <ErrorNotice error={history.error} />
        <Typography sx={{ ...mono, color: 'text.secondary', mb: 1 }}>
          {SOURCE_LABEL[row?.source]} · stasiun {row?.station} · {points.length} sampel terakhir
        </Typography>
        <Sparkline points={points} unit={row?.unit} />
        <TableContainer sx={{ maxHeight: 280, mt: 2 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Waktu sumber</TableCell>
                <TableCell align="right">Nilai</TableCell>
                <TableCell>Kualitas</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(history.data ?? []).slice(0, 50).map((r, i) => (
                <TableRow key={`${r.sourceTs}-${i}`}>
                  <TableCell sx={mono}>{fmtDateTime(r.sourceTs)}</TableCell>
                  <TableCell align="right" sx={{ ...mono, fontWeight: 600 }}>
                    {fmtValue(r)}
                  </TableCell>
                  <TableCell>
                    <QualityDot quality={r.quality} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </DialogContent>
    </Dialog>
  );
}

export default function Telemetry() {
  const [source, setSource] = useState('');
  const [station, setStation] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const latest = useApi('/telemetry/latest', { source, station });

  useLiveChannel('telemetry', (rec) => {
    if (source && rec.source !== source) return;
    if (station && rec.station !== station.toUpperCase()) return;
    latest.setData((prev) => {
      const list = prev ? [...prev] : [];
      const i = list.findIndex((r) => r.assetId === rec.assetId && r.metric === rec.metric);
      if (i >= 0) list[i] = { ...rec, _flash: Date.now() };
      else list.push(rec);
      return list;
    });
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (latest.data ?? [])
      .filter((r) => !q || `${r.assetId} ${r.metric}`.toLowerCase().includes(q))
      .sort((a, b) => `${a.station}${a.assetId}${a.metric}`.localeCompare(`${b.station}${b.assetId}${b.metric}`));
  }, [latest.data, search]);

  return (
    <>
      <PageTitle title="Telemetri">
        <TextField size="small" label="Cari aset atau metric" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ width: 220 }} />
        <FilterSelect label="Sumber" value={source} onChange={setSource} options={Object.entries(SOURCE_LABEL)} />
        <TextField
          size="small"
          label="Stasiun"
          placeholder="mis. LBB"
          value={station}
          onChange={(e) => setStation(e.target.value.toUpperCase())}
          sx={{ width: 120 }}
        />
      </PageTitle>
      <ErrorNotice error={latest.error} />
      <Typography sx={{ fontSize: '0.85rem', color: 'text.secondary', mb: 1 }}>
        Nilai terakhir per aset dalam 24 jam. Pilih baris untuk melihat riwayatnya.
      </Typography>
      <Paper>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Stasiun</TableCell>
                <TableCell>Aset</TableCell>
                <TableCell>Metric</TableCell>
                <TableCell align="right">Nilai</TableCell>
                <TableCell>Kualitas</TableCell>
                <TableCell>Sumber</TableCell>
                <TableCell>Waktu sumber</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {!latest.loading && rows.length === 0 && <EmptyRow colSpan={7}>Tidak ada telemetri yang cocok dengan filter.</EmptyRow>}
              {rows.map((r) => (
                <TableRow
                  key={`${r.assetId}|${r.metric}`}
                  hover
                  tabIndex={0}
                  onClick={() => setSelected(r)}
                  onKeyDown={(e) => e.key === 'Enter' && setSelected(r)}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell sx={{ fontWeight: 600 }}>{r.station}</TableCell>
                  <TableCell>{r.assetId}</TableCell>
                  <TableCell>{r.metric}</TableCell>
                  <TableCell align="right" sx={{ ...mono, fontWeight: 600, fontSize: '0.9rem' }}>
                    {fmtValue(r)}
                  </TableCell>
                  <TableCell>
                    <QualityDot quality={r.quality} />
                  </TableCell>
                  <TableCell>{SOURCE_LABEL[r.source]}</TableCell>
                  <TableCell sx={mono}>
                    <Box component="span" key={r._flash} sx={{ animation: r._flash ? 'mwFlash 1.2s ease-out' : 'none' }}>
                      {fmtTime(r.sourceTs)}
                    </Box>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
      <HistoryDialog row={selected} onClose={() => setSelected(null)} />
    </>
  );
}
