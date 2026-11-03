import { Box } from '@mui/material';
import { tokens } from '../theme';

/**
 * Grafik garis kecil tanpa library. `points` = [{t: Date|string, v: number}] urut waktu naik.
 */
export default function Sparkline({ points, width = 560, height = 120, unit }) {
  const pts = points.filter((p) => Number.isFinite(p.v));
  if (pts.length < 2) {
    return <Box sx={{ color: 'text.secondary', fontSize: '0.85rem', py: 2 }}>Belum cukup data untuk grafik.</Box>;
  }
  const pad = { l: 8, r: 64, t: 10, b: 18 };
  const ts = pts.map((p) => new Date(p.t).getTime());
  const vs = pts.map((p) => p.v);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const x = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (height - pad.t - pad.b);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(ts[i]).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const fmt = (v) => v.toLocaleString('id-ID', { maximumFractionDigits: 2 });

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={`Riwayat nilai, terakhir ${fmt(last.v)} ${unit ?? ''}`}>
      <line x1={pad.l} x2={width - pad.r} y1={y(hi)} y2={y(hi)} stroke={tokens.rule} />
      <line x1={pad.l} x2={width - pad.r} y1={y(lo)} y2={y(lo)} stroke={tokens.rule} />
      <text x={width - pad.r + 6} y={y(hi) + 4} fontSize="11" fill={tokens.inkQuiet} fontFamily={tokens.font.mono}>
        {fmt(hi)}
      </text>
      <text x={width - pad.r + 6} y={y(lo) + 4} fontSize="11" fill={tokens.inkQuiet} fontFamily={tokens.font.mono}>
        {fmt(lo)}
      </text>
      <path d={d} fill="none" stroke={tokens.line} strokeWidth="2" strokeLinejoin="round" />
      <circle cx={x(ts[ts.length - 1])} cy={y(last.v)} r="3.5" fill={tokens.line} />
    </svg>
  );
}
