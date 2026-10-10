import adapter from "@sveltejs/adapter-static";

/** SPA mode per https://svelte.dev/docs/kit/single-page-apps: static files, one fallback page, served by the hub. */
export default {
  kit: {
    adapter: adapter({ fallback: "200.html" }),
    serviceWorker: { register: true },
  },
};
