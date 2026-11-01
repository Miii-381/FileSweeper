import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import MobileApp from "./mobile/MobileApp";
import "./styles.css";

// Android owns a touch-first workspace; desktop behavior remains in its existing root.
const Root = /Android/i.test(navigator.userAgent) ? MobileApp : App;
if (Root === MobileApp) {
  document.documentElement.classList.add("mobile-platform");
  // Document/image viewers own their gestures; the surrounding application stays fixed.
  document.querySelector('meta[name="viewport"]')?.setAttribute("content", "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no");
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
