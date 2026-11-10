// Static, data-free assets embedded by Bun in the compiled Host server too.
import cloud from "../voices/cloud.js" with { type: "file" };
import page from "../voices/index.html" with { type: "file" };
import script from "../voices/page.js" with { type: "file" };
import plotly from "../voices/plotly-4.0.0.min.js" with { type: "file" };
import { router } from "./common";

export function voicePageRoutes() {
  const routes = router();
  for (const [path, file, contentType] of [
    ["/voices", page, "text/html; charset=utf-8"],
    ["/voices/cloud.js", cloud, "text/javascript; charset=utf-8"],
    ["/voices/page.js", script, "text/javascript; charset=utf-8"],
    ["/voices/plotly-4.0.0.min.js", plotly, "text/javascript; charset=utf-8"],
  ] as const) {
    routes.get(
      path,
      () =>
        // Bun types HTML as a bundle even when type: file imports its embedded path.
        new Response(Bun.file(file as string), {
          headers: {
            // Plotly's WebGL bundle compiles shaders locally. No remote scripts, fonts or requests.
            "Content-Security-Policy":
              "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src blob:; worker-src blob:; base-uri 'self'; frame-ancestors 'none'; form-action 'none'",
            "Content-Type": contentType,
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
          },
        })
    );
  }
  return routes;
}
