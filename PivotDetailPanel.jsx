export default function PivotDetailPanel({ pivot }) {
  if (!pivot) return null;
  const isRunning = pivot.systemStatus === 'Running';
  const statusLabel = isRunning
    ? pivot.waterMode === 'Dry'
      ? 'Running, dry'
      : 'Running, wet'
    : 'Stopped';

  const rows = [
    ['Status', statusLabel],
    ['Direction', pivot.direction],
    ['Current position', `${pivot.currentPosition}\u00b0`],
    ['Percent timer', `${pivot.percentTimer}%`],
    ['Pressure', `${pivot.pressure} PSI`],
    ['Last updated', pivot.statusDate],
  ];

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
      <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
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
