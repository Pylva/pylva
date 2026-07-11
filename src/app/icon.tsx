import { ImageResponse } from 'next/og';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

// Generated monogram (no public/ dir in this deployment; Dockerfile ships
// only .next/standalone + .next/static). Teal/cream per the brand palette.
export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0E7C86',
        color: '#FAF7F2',
        fontSize: 22,
        fontWeight: 600,
        fontFamily: 'system-ui, sans-serif',
        borderRadius: 6,
      }}
    >
      P
    </div>,
    { ...size },
  );
}
