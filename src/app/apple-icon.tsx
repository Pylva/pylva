import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

// 180px clears common home-screen icon and logo minimums.
export default function AppleIcon() {
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
        fontSize: 120,
        fontWeight: 600,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      P
    </div>,
    { ...size },
  );
}
