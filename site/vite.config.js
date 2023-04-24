import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import checker from "vite-plugin-checker";
import { macaronVitePlugin } from "@macaron-css/vite";

export default defineConfig({
  plugins: [
    macaronVitePlugin(),
    solidPlugin(),
    wasm(),
    topLevelAwait(),
    checker({ typescript: true }),
  ],
});
