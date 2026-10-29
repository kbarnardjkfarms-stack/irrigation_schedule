import aioLogoFull from './aio-logo-full.png'

// The full AIO logo with "ALL IN ONE" printed directly under the letters AIO,
// lined up from the left edge of the A to the right edge of the O.
// Pass a style with either a height (home page header) or a width + maxWidth
// (login page); the line of text scales with the logo.
export default function AioLogo({ style = {} }) {
  const { height, ...wrapperStyle } = style
  return (
    <span style={{ position: 'relative', display: 'inline-block', lineHeight: 0, ...wrapperStyle }}>
      <img
        src={aioLogoFull}
        alt="AIO — All In One"
        style={{ display: 'block', height: height || 'auto', width: height ? 'auto' : '100%' }}
      />
      <svg
        viewBox="0 0 100 12"
        aria-hidden="true"
        style={{ position: 'absolute', left: '42.2%', top: '82%', width: '57.5%', height: 'auto', overflow: 'visible' }}
      >
        <text x="0" y="9" textLength="100" lengthAdjust="spacing" fontSize="9" fontWeight="600" fill="#1a3550" style={{ fontFamily: 'inherit' }}>
          ALL IN ONE
        </text>
      </svg>
    </span>
  )
}
