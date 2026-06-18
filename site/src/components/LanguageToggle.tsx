import type { Locale } from '../content/copy';

interface LanguageToggleProps {
  locale: Locale;
  onChange: (locale: Locale) => void;
}

export function LanguageToggle({ locale, onChange }: LanguageToggleProps) {
  return (
    <div className="locale-toggle" role="group" aria-label="Language toggle">
      <button type="button" aria-pressed={locale === 'zh'} onClick={() => onChange('zh')}>
        中文
      </button>
      <button type="button" aria-pressed={locale === 'en'} onClick={() => onChange('en')}>
        EN
      </button>
    </div>
  );
}
