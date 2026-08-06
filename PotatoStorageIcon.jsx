export default function PotatoStorageIcon() {
  return (
    <svg width="56" height="56" viewBox="0 0 48 48">
      <defs>
        <linearGradient id="storageBinGradient" x1="10%" y1="0%" x2="90%" y2="100%">
          <stop offset="0%" stopColor="#F0C98A" />
          <stop offset="55%" stopColor="#C9812F" />
          <stop offset="100%" stopColor="#7A4A18" />
        </linearGradient>
      </defs>
      {/* domed roof */}
      <path d="M10 15 C10 8 16 4 24 4 C32 4 38 8 38 15 Z" fill="url(#storageBinGradient)" />
      {/* cylindrical bin body */}
      <rect x="9" y="15" width="30" height="24" rx="2" fill="url(#storageBinGradient)" />
      {/* ridge lines suggesting corrugated siding */}
      <line x1="16" y1="17" x2="16" y2="37" stroke="#7A4A18" strokeWidth="1.2" opacity="0.5" />
      <line x1="24" y1="17" x2="24" y2="37" stroke="#7A4A18" strokeWidth="1.2" opacity="0.5" />
      <line x1="32" y1="17" x2="32" y2="37" stroke="#7A4A18" strokeWidth="1.2" opacity="0.5" />
      {/* base */}
      <rect x="7" y="38" width="34" height="3" rx="1.2" fill="#7A4A18" opacity="0.8" />
    </svg>
  );
}
