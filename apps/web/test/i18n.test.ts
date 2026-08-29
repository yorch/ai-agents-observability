import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCALE,
  format,
  isLocale,
  LOCALE_COOKIE,
  LOCALE_NAMES,
  LOCALES,
} from '../src/i18n/config';
import { DICTIONARIES, type Dictionary, en } from '../src/i18n/dictionary';

describe('isLocale', () => {
  it('accepts supported locales', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('es')).toBe(true);
  });

  it('rejects unsupported locales', () => {
    expect(isLocale('fr')).toBe(false);
    expect(isLocale('')).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(123)).toBe(false);
  });
});

describe('format', () => {
  it('interpolates {placeholders}', () => {
    expect(format('Hello {name}', { name: 'World' })).toBe('Hello World');
  });

  it('handles multiple placeholders', () => {
    expect(format('{a} and {b}', { a: '1', b: '2' })).toBe('1 and 2');
  });

  it('leaves unknown placeholders as-is', () => {
    expect(format('Hello {name}', {})).toBe('Hello {name}');
  });

  it('coerces numbers to strings', () => {
    expect(format('Count: {n}', { n: 42 })).toBe('Count: 42');
  });

  it('handles empty vars', () => {
    expect(format('No placeholders')).toBe('No placeholders');
  });
});

describe('dictionary', () => {
  it('English is the source of truth type', () => {
    const check: Dictionary = en;
    expect(check).toBeDefined();
  });

  it('every locale has a dictionary', () => {
    for (const locale of LOCALES) {
      expect(DICTIONARIES[locale]).toBeDefined();
    }
  });

  it('es is a real Spanish dictionary satisfying Dictionary', () => {
    expect(DICTIONARIES.es).toBeDefined();
    expect(DICTIONARIES.es).not.toBe(en);
    // Spot-check a few translated values
    expect(DICTIONARIES.es.common.back).toBe('Atrás');
    expect(DICTIONARIES.es.rail.signOut).toBe('Cerrar sesión');
    expect(DICTIONARIES.es.me.pageTitle).toBe('Mis Agentes');
  });

  it('all nav keys used by nav-model exist in the dictionary', () => {
    // Spot-check a few keys from each scope to ensure the dictionary covers them.
    expect(en.nav.meOverview).toBe('Overview');
    expect(en.nav.teamRoster).toBe('Roster');
    expect(en.nav.orgDashboard).toBe('Dashboard');
    expect(en.nav.adminJobs).toBe('Jobs');
    expect(en.nav.meGroupMyAgents).toBe('My agents');
    expect(en.nav.orgGroupGovernance).toBe('Governance');
  });

  it('agent labels are present for all known agent types', () => {
    expect(en.agents.CLAUDE_CODE).toBe('Claude Code');
    expect(en.agents.OPENCODE).toBe('opencode');
    expect(en.agents.CODEX).toBe('Codex');
  });

  it('error boundary strings are present', () => {
    expect(en.errorBoundary.title).toBeTruthy();
    expect(en.errorBoundary.retryButton).toBeTruthy();
  });

  it('login strings are present', () => {
    expect(en.login.appTitle).toBe('ai-agents-observability');
    expect(en.login.signInWithGitHub).toBeTruthy();
    expect(en.login.email).toBe('Email');
  });
});

describe('locale config', () => {
  it('default locale is en', () => {
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('locale cookie name is set', () => {
    expect(LOCALE_COOKIE).toBe('obs.locale');
  });

  it('locale names are native-language labels', () => {
    expect(LOCALE_NAMES.en).toBe('English');
    expect(LOCALE_NAMES.es).toBe('Español');
  });

  it('LOCALES is a fixed tuple', () => {
    expect(LOCALES).toEqual(['en', 'es']);
  });
});
