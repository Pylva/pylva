// Helpers for asserting on the raw React element tree returned by awaiting an
// async React Server Component page function (the tests/dashboard convention:
// no DOM render — walk `props.children` recursively).
//
// Structural table assertions match by component identity (el.type ===
// TableCell imported from @/components/ui/table), because pages compose the
// shared primitives rather than raw <td>. The primitives' own class contract
// (horizontal padding et al.) is pinned in tests/frontend/ui-table.test.tsx.

export interface RscElement {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown; className?: string; href?: string };
}

function isElement(node: unknown): node is RscElement {
  return typeof node === 'object' && node !== null && 'props' in node && 'type' in node;
}

export function textContent(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (typeof node === 'object' && 'props' in node) {
    return textContent((node as { props?: { children?: unknown } }).props?.children);
  }
  return '';
}

/** Depth-first collection of every element matching the predicate. */
export function findAll(node: unknown, pred: (el: RscElement) => boolean): RscElement[] {
  const out: RscElement[] = [];
  const walk = (n: unknown): void => {
    if (n === null || n === undefined || typeof n === 'boolean') return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (isElement(n)) {
      if (pred(n)) out.push(n);
      walk(n.props.children);
    }
  };
  walk(node);
  return out;
}

export const byType =
  (type: unknown) =>
  (el: RscElement): boolean =>
    el.type === type;

/** All anchor hrefs in the tree, in document order. */
export function anchorHrefs(node: unknown): string[] {
  return findAll(node, byType('a')).map((a) => String(a.props.href ?? ''));
}
