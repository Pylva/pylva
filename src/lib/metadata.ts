export const PYLVA_PRODUCT_DESCRIPTION = 'Cost infrastructure for AI agent businesses';

export const PYLVA_OG_IMAGE = {
  path: '/opengraph-image',
  width: 1200,
  height: 630,
  alt: 'Pylva cost infrastructure for AI agent businesses',
} as const;

export function productOgImage() {
  return {
    url: PYLVA_OG_IMAGE.path,
    width: PYLVA_OG_IMAGE.width,
    height: PYLVA_OG_IMAGE.height,
    alt: PYLVA_OG_IMAGE.alt,
  };
}
