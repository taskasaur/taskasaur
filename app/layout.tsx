import type { Metadata } from "next";
import "../src/index.css";
export const metadata: Metadata = {
  title: "Taskasaur",
  description: "Your work, together. A local-first workspace.",
  manifest: "/manifest.webmanifest",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
