import { createBrowserRouter } from "react-router";
import { Home } from "./pages/home";
import { NotFound } from "./pages/not-found";
import { RootLayout } from "./site/layout";

/** The home page loads with the site; the demo (Yjs, the client) and the docs load when visited. */
const docs = () => import("./pages/docs");
const demo = () => import("./demo/page");

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/examples", lazy: { Component: () => import("./pages/examples").then((m) => m.Examples) } },
      { path: "/demo", lazy: { Component: () => demo().then((m) => m.DemoNew) } },
      { path: "/demo/:boardId", lazy: { Component: () => demo().then((m) => m.DemoBoard) } },
      {
        path: "/docs",
        lazy: { Component: () => docs().then((m) => m.DocsLayout) },
        children: [
          { index: true, lazy: { Component: () => docs().then((m) => m.Overview) } },
          { path: "client", lazy: { Component: () => docs().then((m) => m.ClientGuide) } },
          { path: "react", lazy: { Component: () => docs().then((m) => m.ReactGuide) } },
          { path: "tokens", lazy: { Component: () => docs().then((m) => m.Tokens) } },
          { path: "cloudflare", lazy: { Component: () => docs().then((m) => m.Cloudflare) } },
          { path: "docker", lazy: { Component: () => docs().then((m) => m.Docker) } },
          { path: "managing", lazy: { Component: () => docs().then((m) => m.Managing) } },
          { path: "reference", lazy: { Component: () => docs().then((m) => m.Reference) } },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
