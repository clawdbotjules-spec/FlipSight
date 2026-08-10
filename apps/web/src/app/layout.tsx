import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Providers } from "@/components/providers";
import "./globals.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Kicks off the first feed request while the JS bundles are still
 * downloading: runs at HTML-parse time, reads the JWT from localStorage, and
 * stashes the in-flight promise for the feed page to adopt (see
 * `window.__dealsPreload` in the feed). Keep the query in sync with the
 * feed's DEFAULT_FILTERS page-one request.
 */
const PRELOAD_SCRIPT = `try{var t=localStorage.getItem("fs_token");if(t){window.__dealsPreload=fetch(${JSON.stringify(
  API_URL,
)}+"/deals?limit=50",{headers:{authorization:"Bearer "+t}}).then(function(r){return r.ok?r.json():Promise.reject(new Error("preload "+r.status))});window.__dealsPreload.catch(function(){});}}catch(e){}`;

export const metadata: Metadata = {
  title: { default: "FlipSight — mission control", template: "%s · FlipSight" },
  description: "Real-time marketplace arbitrage: live deal feed, valuations, and alerts.",
};

export const viewport: Viewport = {
  themeColor: "#0a0e14",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        <link rel="preconnect" href={API_URL} />
        <script dangerouslySetInnerHTML={{ __html: PRELOAD_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
