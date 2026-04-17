import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Orders Schedule",
  description: "Private dashboard for shipment-date order scheduling.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
