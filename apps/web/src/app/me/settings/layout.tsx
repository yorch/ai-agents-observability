import { SettingsNav } from '@/components/me/SettingsNav';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="font-display text-xl font-semibold tracking-tight text-text">Settings</h1>
        <p className="mt-0.5 text-sm text-text-2">Manage your account and privacy preferences.</p>
      </div>
      <div className="flex gap-10">
        <SettingsNav />
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}
