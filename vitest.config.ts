import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live in test/ alongside src/, never inside src/, so that
    // `tsc -b` never emits them into dist/.
    include: ['{apps,packages}/*/test/**/*.test.{ts,js}'],
    environment: 'node',
    passWithNoTests: false,
  },
});
