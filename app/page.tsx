"use client";
import dynamic from "next/dynamic";
import { useEffect } from "react";
const Application = dynamic(() => import("../packages/app-ui/app"), {
  ssr: false,
});
export default function Page() {
  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production")
      void navigator.serviceWorker.register("/sw.js");
  }, []);
  return <Application />;
}
