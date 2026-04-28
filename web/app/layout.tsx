import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SpeechMux",
  description: "Real-time speech transcription powered by SpeechMux",
};

const themeInitScript = `(()=>{try{const m=localStorage.getItem("speechmux_theme");const p=window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches;const r=m==="dark"||m==="light"?m:p?"light":"dark";const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.setAttribute("content",r==="light"?"#f6f8fa":"#1c2128");if(m==="dark"||m==="light")document.documentElement.dataset.theme=m;}catch(_){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <html lang="en">
      <head>
        {/* Inline theme init — must run before first paint to prevent flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <meta name="theme-color" content="#1c2128" />
        <meta name="color-scheme" content="dark light" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </head>
      <body>{children}</body>
    </html>
  );
}
