import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.js"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    setupFiles: ["./tests/setup.js"],
    // Sequential execution keeps outbox / cds.connect state predictable.
    fileParallelism: false,
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
})
