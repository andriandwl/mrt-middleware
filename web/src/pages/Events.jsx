import { useState } from 'react';
import { Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField } from '@mui/material';
import { useApi } from '../hooks/useApi';
import { useLiveChannel } from '../live/LiveContext';
import { EmptyRow, ErrorNotice, FilterSelect, PageTitle, SeverityChip, StateChip, mono } from '../components/common';
import { SEVERITY_LABEL, SOURCE_LABEL, STATE_LABEL, fmtDateTime } from '../format';

const CATEGORY_LABEL = { alarm: 'Alarm', status_change: 'Perubahan status', device_event: 'Event perangkat', log: 'Log' };
const MAX_ROWS = 500;

export default function Events() {
  const [filters, setFilters] = useState({ source: '', severity: '', state: '', category: '', station: '' });
  const set = (k) => (v) => setFilters((f) => ({ ...f, [k]: v }));
  const events = useApi('/events', { ...filters, limit: MAX_ROWS });

  useLiveChannel('event', (rec) => {
    const f = filters;
    if (f.source && rec.source !== f.source) return;
    if (f.severity && rec.severity !== f.severity) return;
    if (f.state && rec.state !== f.state) return;
    if (f.category && rec.category !== f.category) return;
    if (f.station && rec.station !== f.station) return;
    events.setData((prev) => [rec, ...(prev ?? [])].slice(0, MAX_ROWS));
  });

  const rows = events.data ?? [];

  return (
    <>
      <PageTitle title="Event & alarm">
        <FilterSelect label="Severity" value={filters.severity} onChange={set('severity')} options={Object.entries(SEVERITY_LABEL)} width={130} />
        <FilterSelect label="Status" value={filters.state} onChange={set('state')} options={Object.entries(STATE_LABEL)} width={130} />
        <FilterSelect label="Kategori" value={filters.category} onChange={set('category')} options={Object.entries(CATEGORY_LABEL)} />
        <FilterSelect label="Sumber" value={filters.source} onChange={set('source')} options={Object.entries(SOURCE_LABEL)} />
        <TextField
          size="small"
          label="Stasiun"
          placeholder="mis. LBB"
          value={filters.station}
          onChange={(e) => set('station')(e.target.value.toUpperCase())}
          sx={{ width: 120 }}
        />
      </PageTitle>
      <ErrorNotice error={events.error} />
      <Paper>
        <TableContainer sx={{ maxHeight: 'calc(100vh - 320px)', minHeight: 300 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Waktu sumber</TableCell>
                <TableCell>Severity</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Stasiun</TableCell>
                <TableCell>Aset</TableCell>
                <TableCell>Pesan</TableCell>
                <TableCell>Kode</TableCell>
                <TableCell>Sumber</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {!events.loading && rows.length === 0 && <EmptyRow colSpan={8}>Tidak ada event yang cocok dengan filter.</EmptyRow>}
              {rows.map((e, i) => (
                <TableRow key={`${e.sourceTs}-${e.assetId}-${i}`} hover>
                  <TableCell sx={{ ...mono, whiteSpace: 'nowrap' }}>{fmtDateTime(e.sourceTs)}</TableCell>
                  <TableCell>
                    <SeverityChip severity={e.severity} />
                  </TableCell>
                  <TableCell>
                    <StateChip state={e.state} />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{e.station}</TableCell>
                  <TableCell>{e.assetId}</TableCell>
                  <TableCell sx={{ maxWidth: 420 }}>{e.message}</TableCell>
                  <TableCell sx={mono}>{e.code ?? '—'}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{SOURCE_LABEL[e.source]}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
    </>
  );
}
