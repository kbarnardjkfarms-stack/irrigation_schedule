// Irrigation Reports view (opened from the views dropdown in the header).
// For now this is only the page that the dropdown opens to; the report
// itself is added next.
export default function IrrigationReports() {
  return (
    <div style={{ maxWidth: '720px', margin: '24px auto', padding: '0 16px' }}>
      <div style={{ background: '#fff', border: '1px solid #e4e1d8', borderRadius: '10px', padding: '20px 22px' }}>
        <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>Reports</div>
        <div style={{ fontSize: '14px', color: '#555', lineHeight: 1.5 }}>
          Irrigation reports are coming here: compare fields by water scheduled and applied against crop ET and soil moisture.
        </div>
      </div>
    </div>
  )
}
