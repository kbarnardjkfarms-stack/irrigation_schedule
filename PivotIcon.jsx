const COLORS = {
  wet: '#378ADD',
  dry: '#97C459',
  stopped: '#B8BDC7',
};

function polar(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

function sectorPath(cx, cy, r, s, e) {
  const start = polar(cx, cy, r, s);
  const end = polar(cx, cy, r, e);
  let diff = e - s;
  if (diff < 0) diff += 360;
  const large = diff > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x.toFixed(1)} ${start.y.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${end.x.toFixed(1)} ${end.y.toFixed(1)} Z`;
}

/**
 * Renders the pivot coverage/status icon.
 * pivot: the Firestore document from the `pivots` collection, or null/undefined
 * if this field has no pivot mapped yet (renders a neutral placeholder).
 */
export default function PivotIcon({ pivot, size = 40, onClick, stuckAlert = false }) {
  if (!pivot) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        role="img"
        aria-label="No pivot connected"
      >
        <circle
          cx="20"
          cy="20"
          r="16"
          fill="none"
          stroke="#B8BDC7"
          strokeWidth="1.5"
          strokeDasharray="3 3"
        />
      </svg>
    );
  }

  const { systemStatus, waterMode, direction, currentPosition, reverseAngle, forwardAngle } = pivot;
  const isRunning = systemStatus === 'Running';
  const state = isRunning ? (waterMode === 'Dry' ? 'dry' : 'wet') : 'stopped';
  const fill = COLORS[state];
  const cx = 20;
  const cy = 20;
  const r = 16;
  const pos = Number(currentPosition) || 0;

  // A full-circle pivot (no arc restriction) reports the same reverse and
  // forward angle from BaseStation3 — commonly 0/0, meaning "goes all the
  // way around," not "no data." Detect that BEFORE applying any fallback,
  // since 0 is a real, meaningful value here and shouldn't be treated as
  // missing. Sector math on equal start/end angles produces a degenerate,
  // zero-area path, which is why this used to render as just a bare line.
  const rev = Number(reverseAngle) || 0;
  const fwd = Number(forwardAngle) || 0;
  const isFullCircle = rev === fwd;

  const edgePt = polar(cx, cy, r, pos);
  const offset = 10;
  const chevronAngle = direction === 'Forward' ? pos + offset : pos - offset;
  const innerPt = polar(cx, cy, r * 0.62, chevronAngle);
  const travel = direction === 'Forward' ? pos + 90 : pos - 90;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role="img"
      aria-label={`Pivot ${state}, ${direction}, position ${pos.toFixed(1)} degrees`}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      {isFullCircle ? (
        <circle cx={cx} cy={cy} r={r} fill={fill} />
      ) : (
        <path d={sectorPath(cx, cy, r, rev, fwd)} fill={fill} />
      )}
      <line
        x1={cx}
        y1={cy}
        x2={edgePt.x.toFixed(1)}
        y2={edgePt.y.toFixed(1)}
        stroke="#1A1A1A"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <g transform={`translate(${innerPt.x.toFixed(1)}, ${innerPt.y.toFixed(1)}) rotate(${travel.toFixed(1)})`}>
        <path
          d="M -4,3 L 0,-4.5 L 4,3"
          fill="none"
          stroke="#1A1A1A"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      {stuckAlert && (
        <g aria-label="Alert: possible parked wet pivot">
          <circle cx="33" cy="7" r="7" fill="#A32D2D" stroke="#fff" strokeWidth="1.5" />
          <text x="33" y="7" textAnchor="middle" dy="0.35em" fill="#fff" fontSize="10" fontWeight="700">!</text>
        </g>
      )}
    </svg>
  );
}
