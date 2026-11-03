import { Box, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import { useApi } from '../hooks/useApi';
import { EmptyRow, ErrorNotice, PageTitle, mono } from '../components/common';
import { CONNECTOR_STATE_LABEL, SOURCE_LABEL, fmtAgo, fmtDateTime } from '../format';
import { tokens } from '../theme';

const STATE_COLOR = {
  connected: tokens.signal.good,
  connecting: tokens.signal.minor,
  error: tokens.signal.critical,
  disconnected: tokens.signal.critical,
};

export default function Connectors() {
  const connectors = useApi('/connectors', {}, { refreshMs: 5000 });
  const rows = connectors.data ?? [];

  return (
    <>
      <PageTitle title="Konektor" />
      <Typography sx={{ fontSize: '0.85rem', color: 'text.secondary', mb: 1 }}>
        Semua konektor bersifat read-only terhadap sistem sumber. Diperbarui setiap 5 detik.
      </Typography>
      <ErrorNotice error={connectors.error} />
      <Paper>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Konektor</TableCell>
                <TableCell>Sumber</TableCell>
                <TableCell>Protokol</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Data terakhir</TableCell>
                <TableCell align="right">Percobaan ulang</TableCell>
                <TableCell>Error terakhir</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {!connectors.loading && rows.length === 0 && <EmptyRow colSpan={7}>Tidak ada konektor aktif.</EmptyRow>}
              {rows.map((c) => {
                const color = STATE_COLOR[c.state] ?? tokens.signal.idle;
                return (
                  <TableRow key={c.id}>
                    <TableCell sx={{ ...mono, fontWeight: 600 }}>{c.id}</TableCell>
                    <TableCell>{SOURCE_LABEL[c.source]}</TableCell>
                    <TableCell sx={mono}>{c.type}</TableCell>
                    <TableCell>
                      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, color, fontWeight: 600 }}>
                        <Box component="span" aria-hidden sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: color }} />
                        {CONNECTOR_STATE_LABEL[c.state] ?? c.state}
                      </Box>
                    </TableCell>
                    <TableCell sx={mono} title={fmtDateTime(c.lastRecordTs)}>
                      {fmtAgo(c.lastRecordTs)}
                    </TableCell>
                    <TableCell align="right" sx={mono}>
                      {c.reconnectAttempts}
                    </TableCell>
                    <TableCell sx={{ ...mono, color: c.lastError ? tokens.signal.critical : 'text.secondary', maxWidth: 360 }}>
                      {c.lastError ?? '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
    </>
  );
}
