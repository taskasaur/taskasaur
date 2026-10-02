import React from "react";
import ReactDOM from "react-dom/client";
import Application from "../packages/app-ui/app";
import "./index.css";
if (
  import.meta.env.PROD &&
  /^https?:$/.test(location.protocol) &&
  "serviceWorker" in navigator
) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/sw.js")
      .catch((error) =>
        console.error("Offline shell registration failed", error),
      );
  });
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Application />
  </React.StrictMode>,
);
