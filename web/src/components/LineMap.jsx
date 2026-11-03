import { Box, Tooltip, Typography } from '@mui/material';
import { keyframes } from '@mui/system';
import { useEffect, useState } from 'react';
import { getReady } from '../api';
import { useLive } from '../live/LiveContext';
import { tokens } from '../theme';
import { CONNECTOR_STATE_LABEL, SOURCE_LABEL } from '../format';

const SOURCES = ['scada', 'nms', 'pids'];
const STATE_RANK = { error: 5, disconnected: 4, connecting: 3, stopped: 2, idle: 1, connected: 0 };

function stateColor(state) {
  if (!state) return tokens.signal.idle;
  if (state === 'connected') return tokens.signal.good;
  if (state === 'connecting') return tokens.signal.minor;
  if (state === 'error' || state === 'disconnected') return tokens.signal.critical;
  return tokens.signal.idle;
}

const pulse = keyframes`
  0% { box-shadow: 0 0 0 0 rgba(35,132,90,0.45); }
  70% { box-shadow: 0 0 0 8px rgba(35,132,90,0); }
  100% { box-shadow: 0 0 0 0 rgba(35,132,90,0); }
`;

function Station({ label, state, detail }) {
  const color = stateColor(state);
  return (
    <Tooltip title={detail} arrow>
      <Box
        tabIndex={0}
        sx={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 96 }}
      >
        <Box
          aria-hidden
          sx={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            bgcolor: tokens.surface,
            border: `5px solid ${color}`,
            outline: `3px solid ${tokens.surface}`,
          }}
        />
        <Typography variant="h3" component="span" sx={{ mt: 1, whiteSpace: 'nowrap', fontSize: { xs: '0.95rem', sm: '1.1rem' } }}>
          {label}
        </Typography>
        <Typography component="span" sx={{ fontFamily: tokens.font.mono, fontSize: '0.72rem', color }}>
          {state ? CONNECTOR_STATE_LABEL[state] ?? state : 'Belum dikonfigurasi'}
        </Typography>
      </Box>
    </Tooltip>
  );
}

/**
 * Ciri khas dashboard: sistem sumber digambar sebagai stasiun pada satu jalur,
 * mengalir ke middleware sebagai terminus. Warna cincin = status konektor (/ready).
 */
export default function LineMap() {
  const { status: liveStatus } = useLive();
  const [ready, setReady] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getReady()
        .then((r) => alive && setReady(r))
        .catch(() => alive && setReady({ status: 'unreachable', connectors: [] }));
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const bySource = Object.fromEntries(
    SOURCES.map((src) => {
      const list = (ready?.connectors ?? []).filter((c) => c.source === src);
      const worst = list.reduce((acc, c) => (STATE_RANK[c.state] > STATE_RANK[acc] ? c.state : acc), list[0]?.state);
      const detail = list.length
        ? list.map((c) => `${c.id}: ${CONNECTOR_STATE_LABEL[c.state] ?? c.state}`).join(' · ')
        : 'Tidak ada konektor aktif untuk sumber ini';
      return [src, { state: worst, detail }];
    }),
  );

  const dbDown = ready && ready.database !== 'up';
  const terminusText = dbDown
    ? 'Database tidak terhubung'
    : { live: 'Data live', connecting: 'Menyambung…', offline: 'Live terputus' }[liveStatus];
  const terminusColor = dbDown || liveStatus === 'offline' ? tokens.signal.critical : liveStatus === 'live' ? tokens.signal.good : tokens.signal.minor;

  return (
    <Box
      component="section"
      aria-label="Status sistem sumber"
      sx={{ bgcolor: tokens.surface, borderBottom: `1px solid ${tokens.rule}`, px: { xs: 2, md: 4 }, pt: 2.5, pb: 2, overflowX: 'auto' }}
    >
      <Box sx={{ position: 'relative', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', minWidth: 520, maxWidth: 1100 }}>
        {/* garis jalur */}
        <Box aria-hidden sx={{ position: 'absolute', left: 48, right: 64, top: 8, height: 6, borderRadius: 3, bgcolor: tokens.line }} />
        {SOURCES.map((src) => (
          <Station key={src} label={SOURCE_LABEL[src]} state={bySource[src].state} detail={bySource[src].detail} />
        ))}
        {/* terminus: middleware */}
        <Box sx={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 120 }}>
          <Box
            aria-hidden
            sx={{
              width: 30,
              height: 22,
              borderRadius: '4px',
              bgcolor: tokens.line,
              outline: `3px solid ${tokens.surface}`,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                bgcolor: terminusColor,
                animation: liveStatus === 'live' && !dbDown ? `${pulse} 2s infinite` : 'none',
              }}
            />
          </Box>
          <Typography variant="h3" component="span" sx={{ mt: 1, whiteSpace: 'nowrap', fontSize: { xs: '0.95rem', sm: '1.1rem' } }}>
            Middleware
          </Typography>
          <Typography component="span" sx={{ fontFamily: tokens.font.mono, fontSize: '0.72rem', color: terminusColor }}>
            {terminusText}
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}
