import { defineConfig } from 'vitest/config';

// The golden export and the date tests use local time; pin it so results do not
// depend on the machine. Set before workers start so they inherit it.
process.env.TZ = 'Europe/Stockholm';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
