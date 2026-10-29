import { createBrowserRouter } from "react-router";
import { NotFound } from "./pages/not-found";
import { RootLayout } from "./site/layout";

/** Every page loads when visited: the home page, the demo (Yjs, the client), the docs. */
const docs = () => import("./pages/docs");
const demo = () => import("./demo/page");

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: "/", lazy: { Component: () => import("./pages/home").then((m) => m.Home) } },
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
