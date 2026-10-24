import { SettingsNav } from '@/components/me/SettingsNav';
import { getTranslations } from '@/i18n/server';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { dict } = await getTranslations();
  return (
    <div>
      <div className="mb-6">
        <h1 className="font-display text-xl font-semibold tracking-tight text-text">
          {dict.me.settings.title}
        </h1>
        <p className="mt-0.5 text-sm text-text-2">{dict.me.settings.description}</p>
      </div>
      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <SettingsNav />
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}
