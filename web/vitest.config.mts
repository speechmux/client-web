import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests cover the pure modules under lib/ only; they run in plain Node with no
// browser or DOM, so nothing here needs a running SpeechMux stack.
export default defineConfig({
  resolve: {
    // Same "@/…" alias as tsconfig.json's `paths`.
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
