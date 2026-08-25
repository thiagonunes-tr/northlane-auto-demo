import type { Metadata } from "next";
import ApiDocs from "../../shared/ApiDocs";

export const metadata: Metadata = {
  title: "Northlane Auto | API Documentation",
  description: "Interactive OpenAPI documentation for Northlane Auto QA automation.",
};

export default function ApiDocsPage() {
  return <ApiDocs />;
}
