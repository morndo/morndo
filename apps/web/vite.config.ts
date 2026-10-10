import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// In development the hub runs separately; /api (including the WebSocket) is proxied to it.
export default defineConfig({
  plugins: [sveltekit()],
  // Never inline assets as data: URLs: the hub's CSP allows fonts and images from 'self' only.
  build: { assetsInlineLimit: 0 },
  server: { proxy: { "/api": { target: "http://127.0.0.1:8790", ws: true } } },
});
