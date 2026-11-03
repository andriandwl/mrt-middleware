import { Alert, Box, Chip, MenuItem, TableCell, TableRow, TextField, Typography } from '@mui/material';
import { tokens } from '../theme';
import { SEVERITY_LABEL, STATE_LABEL } from '../format';

export function PageTitle({ title, children }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: 2, mb: 2 }}>
      <Typography variant="h2" component="h2" sx={{ flexGrow: 1 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

export function SeverityChip({ severity }) {
  const color = tokens.signal[severity] ?? tokens.signal.info;
  return (
    <Chip
      size="small"
      label={SEVERITY_LABEL[severity] ?? severity}
      sx={{ bgcolor: `${color}1A`, color, border: `1px solid ${color}55`, minWidth: 64 }}
    />
  );
}

export function StateChip({ state }) {
  const active = state === 'active';
  return (
    <Chip
      size="small"
      variant={active ? 'filled' : 'outlined'}
      label={STATE_LABEL[state] ?? state}
      sx={active ? { bgcolor: tokens.ink, color: '#fff' } : { color: tokens.inkQuiet }}
    />
  );
}

export function QualityDot({ quality }) {
  const color = { good: tokens.signal.good, uncertain: tokens.signal.minor, bad: tokens.signal.critical }[quality] ?? tokens.signal.idle;
  const label = { good: 'Baik', uncertain: 'Ragu', bad: 'Buruk' }[quality] ?? quality;
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, fontSize: '0.8rem' }}>
      <Box component="span" aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color }} />
      {label}
    </Box>
  );
}

export function ErrorNotice({ error }) {
  if (!error) return null;
  return (
    <Alert severity={error.status === 403 ? 'warning' : 'error'} sx={{ mb: 2 }}>
      {error.message}
    </Alert>
  );
}

export function EmptyRow({ colSpan, children }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} sx={{ py: 4, textAlign: 'center', color: 'text.secondary', borderBottom: 'none' }}>
        {children}
      </TableCell>
    </TableRow>
  );
}

/** Dropdown filter sederhana; opsi kosong = semua. */
export function FilterSelect({ label, value, onChange, options, width = 160 }) {
  return (
    <TextField select size="small" label={label} value={value} onChange={(e) => onChange(e.target.value)} sx={{ width }}>
      <MenuItem value="">Semua</MenuItem>
      {options.map(([v, l]) => (
        <MenuItem key={v} value={v}>
          {l}
        </MenuItem>
      ))}
    </TextField>
  );
}

export const mono = { fontFamily: tokens.font.mono, fontSize: '0.8rem' };
