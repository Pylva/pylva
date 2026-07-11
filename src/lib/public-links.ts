export const PYLVA_DOCS_URL = 'https://docs.pylva.com';

export const PYLVA_SLACK_SUPPORT_URL =
  'https://join.slack.com/t/pylva/shared_invite/zt-4357amddc-QvNEhpxYU~6DyrF5P6Cw8Q';

// newTab is an explicit opt-in: absent means same-tab, even for external URLs.
export type PublicLink = { href: string; label: string; newTab?: boolean };
