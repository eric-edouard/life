import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  redirect,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SignedOut } from "./api";
import { DecisionsPage } from "./decisions/page";
import { applyTheme, readTheme } from "./decisions/theme";
import { nextOf, SignInRoute } from "./sign-in";
import "./styles.css";

// Life's web app: each page a route. Every route's data comes from /api/, and a signed-out answer goes to /sign-in.

const root = createRootRoute({ component: Outlet });
const routes = [
  createRoute({
    beforeLoad: () => {
      throw redirect({ to: "/decisions" });
    },
    getParentRoute: () => root,
    path: "/",
  }),
  createRoute({
    component: DecisionsPage,
    getParentRoute: () => root,
    path: "/decisions",
  }),
  createRoute({
    component: SignInRoute,
    getParentRoute: () => root,
    path: "/sign-in",
    validateSearch: (s: Record<string, unknown>) => ({ next: nextOf(s.next) }),
  }),
] as const;
const router = createRouter({ routeTree: root.addChildren([...routes]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: (n, e) => !(e instanceof SignedOut) && n < 2 },
  },
  queryCache: new QueryCache({
    onError: (e) => {
      if (e instanceof SignedOut) {
        const here = globalThis.location.pathname + globalThis.location.hash;
        router.navigate({ search: { next: here }, to: "/sign-in" });
      }
    },
  }),
});

applyTheme(readTheme());
const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>
  );
}
