// The state gallery is development only (ADR-0008 phase G). SvelteKit 2 builds every route in src/routes, so the
// route itself stays in a production build, answering 404; the gallery and its data are imported only under
// import.meta.env.DEV, which Vite replaces with false in a build, so they are left out (checked by scripts/check-build.ts).
import { error } from "@sveltejs/kit";

export function load() {
  if (!import.meta.env.DEV) error(404, "Not Found");
}
