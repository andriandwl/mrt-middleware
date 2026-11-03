import { createTheme } from '@mui/material/styles';

/**
 * Token visual. Palet diambil dari dunia papan informasi stasiun:
 * biru jalur sebagai warna utama, kertas abu dingin sebagai latar,
 * dan warna sinyal hanya untuk status (tidak dipakai sebagai hiasan).
 */
export const tokens = {
  paper: '#EEF1F4', // latar
  surface: '#FFFFFF', // kartu & tabel
  ink: '#14202B', // teks utama
  inkQuiet: '#5B6876', // teks sekunder
  rule: '#D3D9E0', // garis
  line: '#1D3C78', // biru jalur — warna utama
  signal: {
    critical: '#C8102E',
    major: '#E06A14',
    minor: '#B98A00',
    info: '#5B6876',
    good: '#23845A',
    idle: '#9AA5B1',
  },
  font: {
    display: '"Barlow Condensed", "Arial Narrow", sans-serif',
    body: '"IBM Plex Sans", system-ui, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, monospace',
  },
};

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: tokens.line },
    error: { main: tokens.signal.critical },
    warning: { main: tokens.signal.major },
    success: { main: tokens.signal.good },
    background: { default: tokens.paper, paper: tokens.surface },
    text: { primary: tokens.ink, secondary: tokens.inkQuiet },
    divider: tokens.rule,
  },
  shape: { borderRadius: 6 },
  typography: {
    fontFamily: tokens.font.body,
    fontSize: 14,
    h1: { fontFamily: tokens.font.display, fontWeight: 600, fontSize: '2rem', letterSpacing: '0.01em' },
    h2: { fontFamily: tokens.font.display, fontWeight: 600, fontSize: '1.5rem', letterSpacing: '0.01em' },
    h3: { fontFamily: tokens.font.display, fontWeight: 600, fontSize: '1.15rem', letterSpacing: '0.02em' },
    overline: {
      fontFamily: tokens.font.display,
      fontWeight: 600,
      fontSize: '0.8rem',
      letterSpacing: '0.12em',
      lineHeight: 1.6,
    },
    button: { textTransform: 'none', fontWeight: 600 },
  },
  components: {
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: { root: { border: `1px solid ${tokens.rule}` } },
    },
    MuiAppBar: { styleOverrides: { root: { border: 'none' } } },
    MuiTableCell: {
      styleOverrides: {
        head: {
          fontFamily: tokens.font.display,
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          fontSize: '0.8rem',
          color: tokens.inkQuiet,
          background: tokens.surface,
        },
        root: { borderColor: tokens.rule, paddingTop: 8, paddingBottom: 8 },
      },
    },
    MuiChip: { styleOverrides: { root: { fontWeight: 600, borderRadius: 4 } } },
    MuiButtonBase: { defaultProps: { disableRipple: false } },
    MuiCssBaseline: {
      styleOverrides: {
        '*:focus-visible': { outline: `2px solid ${tokens.line}`, outlineOffset: 2 },
        '@media (prefers-reduced-motion: reduce)': {
          '*': { animation: 'none !important', transition: 'none !important' },
        },
      },
    },
  },
});
