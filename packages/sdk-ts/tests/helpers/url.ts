export interface ExactRequestTarget {
  readonly origin: string;
  readonly pathname: string;
  readonly method: string;
}

/** Match a mocked fetch call without accepting URL lookalikes or method drift. */
export function matchesExactRequest(
  input: string | URL | Request,
  request: RequestInit | undefined,
  target: ExactRequestTarget,
): boolean {
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : input);
  } catch {
    return false;
  }

  const method = (
    request?.method ?? (input instanceof Request ? input.method : 'GET')
  ).toUpperCase();
  return (
    method === target.method.toUpperCase() &&
    url.origin === target.origin &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === target.pathname &&
    url.search === '' &&
    url.hash === ''
  );
}
