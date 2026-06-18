import { describe, expect, test } from 'vitest';
import { configDefaults } from 'vitest/config';
import config from '../../vitest.config';

describe('root vitest config', () => {
  test('excludes the GitHub Pages site tests so they use the site runner', () => {
    expect(config.test?.exclude).toContain('site/**');
    expect(config.test?.exclude).toEqual(expect.arrayContaining(configDefaults.exclude));
  });
});
