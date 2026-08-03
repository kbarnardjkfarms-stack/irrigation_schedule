export default function PivotDetailPanel({ pivot }) {
  if (!pivot) return null;

  const isRunning = pivot.systemStatus === 'Running';
  const statusLabel = isRunning
    ? pivot.waterMode === 'Dry'
      ? 'Running, dry'
      : 'Running, wet'
    : 'Stopped';

  return (
    <div
      style={{
        padding: '12px 16px',
        background: '#F7F8FA',
        borderRadius: '0 0 8px 8px',
        border: '1px solid #E2E4E8',
        borderTop: 'none',
      }}
    >
      <table style={{ width: '100%', fontSize: 13 }}>
        <tbody>
          <tr>
            <td>Status</td>
            <td style={{ textAlign: 'right' }}>{statusLabel}</td>
          </tr>
          <tr>
            <td>Direction</td>
            <td style={{ textAlign: 'right' }}>{pivot.direction}</td>
          </tr>
          <tr>
            <td>Current position</td>
            <td style={{ textAlign: 'right' }}>{pivot.currentPosition}&deg;</td>
          </tr>
          <tr>
            <td>Percent timer</td>
            <td style={{ textAlign: 'right' }}>{pivot.percentTimer}%</td>
          </tr>
          <tr>
            <td>Pressure</td>
            <td style={{ textAlign: 'right' }}>{pivot.pressure} PSI</td>
          </tr>
          <tr>
            <td>Last updated</td>
            <td style={{ textAlign: 'right' }}>{pivot.statusDate}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
