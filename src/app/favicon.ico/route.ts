export const dynamic = 'force-static';

// Legacy clients request /favicon.ico unconditionally; the real icon is the
// generated /icon route (src/app/icon.tsx). Relative Location keeps the
// redirect correct on every deploy host.
export function GET() {
  return new Response(null, {
    status: 308,
    headers: { Location: '/icon' },
  });
}
