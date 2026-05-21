import Link from 'next/link';

export function Footer() {
  return (
    <footer className="mt-auto border-t border-white/10 px-6 py-3 text-xs text-white/50">
      <Link href="/me/privacy" className="hover:underline">
        Privacy &amp; what's collected
      </Link>
    </footer>
  );
}
