import { PYLVA_DOCS_URL } from '@/lib/public-links';

// Root layout's title template appends "— Pylva".
export const metadata = { title: 'Page not found' };

// Root not-found: neutral styling for the self-host product shell. Hosted
// website 404 handling is owned by pylva-internal.
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-2xl flex-col justify-center px-6 py-24">
      <p className="font-mono text-sm text-neutral-500">404</p>
      <h1 className="mt-3 text-3xl font-semibold">Page not found</h1>
      <p className="mt-3 text-neutral-600">
        The URL does not match a page on this site. It may have moved or never existed.
      </p>
      <ul className="mt-8 flex flex-col gap-2">
        <li>
          <a href="/" className="underline underline-offset-4">
            Home
          </a>
        </li>
        <li>
          <a href={PYLVA_DOCS_URL} className="underline underline-offset-4">
            Docs — SDK quickstart
          </a>
        </li>
      </ul>
    </main>
  );
}
