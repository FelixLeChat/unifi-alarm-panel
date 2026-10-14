import type { Metadata, Viewport } from "next";
import "./panel.css";

export const metadata: Metadata = {
  title: "Alarm panel",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  return children;
}
