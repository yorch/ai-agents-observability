import Link from 'next/link';

export default function TeamNotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="text-4xl font-semibold text-white/20">404</p>
      <p className="mt-3 text-lg font-medium">Team not found</p>
      <p className="mt-1 text-sm text-white/50">
        This team doesn't exist or you don't have access to it.
      </p>
      <Link
        href="/me"
        className="mt-6 rounded-md border border-white/10 px-4 py-2 text-sm hover:bg-white/5 transition-colors"
      >
        Back to My Agents
      </Link>
    </div>
  );
}
