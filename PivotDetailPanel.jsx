const FARM_TZ = 'America/Boise';

// "3:16 PM yesterday (17 h)" from the time the status began (FieldNET or BaseStation).
function sinceText(iso, now = new Date()) {
  const t = iso ? new Date(iso) : null;
  if (!t || isNaN(t.getTime())) return null;
  const mins = Math.max(0, Math.round((now.getTime() - t.getTime()) / 60000));
  const dayKey = (d) => d.toLocaleDateString('en-CA', { timeZone: FARM_TZ });
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  const time = t.toLocaleTimeString('en-US', { timeZone: FARM_TZ, hour: 'numeric', minute: '2-digit' });
  let day;
  if (dayKey(t) === dayKey(now)) day = 'today';
  else if (dayKey(t) === dayKey(yesterday)) day = 'yesterday';
  else day = t.toLocaleDateString('en-US', { timeZone: FARM_TZ, weekday: 'short', month: 'short', day: 'numeric' });
  const age = mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`;
  return `${time} ${day} (${age})`;
}

const TONES = {
  fault: { background: '#FBEAEA', border: '#E8B4B4', color: '#A32D2D' },
  warning: { background: '#FAEEDA', border: '#F0D9A8', color: '#854F0B' },
  info: { background: '#F1EFE8', border: '#D3D1C7', color: '#444441' },
};

const show = (v, suffix = '') => (v === null || v === undefined || v === '' || v === 'null' || v === 'undefined' ? '—' : `${v}${suffix}`);

export default function PivotDetailPanel({ pivot }) {
  if (!pivot) return null;
  const isRunning = pivot.systemStatus === 'Running';
  const statusLabel = isRunning
    ? pivot.waterMode === 'Dry'
      ? 'Running, dry'
      : 'Running, wet'
    : pivot.systemStatus === 'No signal'
      ? 'No signal'
      : 'Stopped';

  const rows = [
    ['Status', statusLabel],
    ['Direction', show(pivot.direction)],
    ['Current position', show(pivot.currentPosition, '°')],
    ['Percent timer', show(pivot.percentTimer, '%')],
    ['Pressure', show(pivot.pressure, ' PSI')],
    ['Last updated', show(pivot.statusDate)],
  ];

  // FieldNET and BaseStation/AgSense pivots carry the exact reason for a stop or fault
  // (statusLabel / statusTone / statusSince, written by their syncs).
  const tone = pivot.statusTone ? TONES[pivot.statusTone] || TONES.info : null;
  const since = tone ? sinceText(pivot.statusSince || pivot.fieldnetLastUpdated) : null;

  return (
    <div
      style={{
        maxWidth: 320,
        padding: '12px 16px',
        background: '#F7F8FA',
        borderRadius: '0 0 8px 8px',
        border: '1px solid #E2E4E8',
        borderTop: 'none',
      }}
    >
      {tone && (
        <div
          style={{
            marginBottom: 8,
            padding: '8px 10px',
            borderRadius: 8,
            background: tone.background,
            border: `1px solid ${tone.border}`,
            color: tone.color,
            fontSize: 12,
          }}
        >
          <strong>{pivot.statusFull || pivot.statusLabel}</strong>
          {since ? ` since ${since}` : ''}
        </div>
      )}
      <table style={{ width: '100%', minWidth: 0, fontSize: 13, borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map(([label, value], i) => (
            <tr key={label}>
              <td
                style={{
                  padding: '5px 0',
                  borderBottom: i < rows.length - 1 ? '1px solid #E2E4E8' : 'none',
                  color: '#666',
                }}
              >
                {label}
              </td>
              <td
                style={{
                  padding: '5px 0',
                  borderBottom: i < rows.length - 1 ? '1px solid #E2E4E8' : 'none',
                  textAlign: 'right',
                  fontWeight: 500,
                }}
              >
                {value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
