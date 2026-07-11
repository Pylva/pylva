import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Pylva',
    short_name: 'Pylva',
    description: 'Cost infrastructure for AI agent businesses',
    start_url: '/',
    display: 'browser',
    background_color: '#FAF7F2',
    theme_color: '#0E7C86',
    icons: [
      { src: '/icon', sizes: '32x32', type: 'image/png' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  };
}
