import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/og.png`;

  // This entry point serves the same app as vercel-frontend/index.html, so it
  // must carry the same disclosure. A shared link is often the first thing
  // anyone sees, and an insurance brand reads as a real product.
  const title = "Northlane Auto | Policyholder Portal (demo)";
  const description =
    "A fictional car insurance portal used for QA automation training. No real policy, claim, or payment data.";

  return {
    title,
    description,
    icons: { icon: "/favicon.svg" },
    openGraph: {
      title,
      description,
      type: "website",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "Northlane Auto demo portal: a fictional car insurance portal for QA automation training" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
