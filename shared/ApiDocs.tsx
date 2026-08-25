"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- This component is also rendered by the standalone Vite frontend. */

import {
  type ComponentType,
  useEffect,
  useState,
} from "react";

type SwaggerRequest = {
  credentials?: RequestCredentials;
};

type SwaggerUIComponent = ComponentType<{
  url: string;
  deepLinking?: boolean;
  displayRequestDuration?: boolean;
  docExpansion?: "list" | "full" | "none";
  filter?: boolean;
  persistAuthorization?: boolean;
  requestInterceptor?: (request: SwaggerRequest) => SwaggerRequest;
}>;

export default function ApiDocs() {
  const [SwaggerUI, setSwaggerUI] = useState<SwaggerUIComponent | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([
      import("swagger-ui-react"),
      import("swagger-ui-react/swagger-ui.css"),
    ])
      .then(([module]) => {
        if (active) {
          setSwaggerUI(() => module.default as SwaggerUIComponent);
        }
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="api-docs-page">
      <header className="api-docs-header">
        <a className="api-docs-brand" href="/" aria-label="Return to Northlane Auto">
          <span className="brand-mark small" aria-hidden="true"><i /><b /></span>
          <span>Northlane <strong>Auto</strong></span>
        </a>
        <div className="api-docs-heading">
          <p>QA AUTOMATION</p>
          <h1>Interactive API documentation</h1>
          <span>
            Explore the contract, inspect examples, and execute requests against
            the current environment.
          </span>
        </div>
        <nav className="api-docs-links" aria-label="API documentation links">
          <a href="/openapi.json" download>Download OpenAPI</a>
          <a href="/">Open application</a>
        </nav>
      </header>

      <section className="api-docs-notice" aria-label="QA usage notice">
        <strong>Before trying protected operations</strong>
        <span>
          Execute the fixed-account bypass in <code>POST /api/auth/login</code>.
          The browser will retain the HTTP-only session cookie automatically.
          Use <code>DELETE /api/demo-state</code> to restore deterministic data.
        </span>
      </section>

      <section className="api-docs-console" aria-label="Swagger API console">
        {loadError ? (
          <div className="api-docs-error" role="alert">
            The interactive console could not be loaded. You can still download
            the OpenAPI contract above.
          </div>
        ) : SwaggerUI ? (
          <SwaggerUI
            url="/openapi.json"
            deepLinking
            displayRequestDuration
            docExpansion="list"
            filter
            persistAuthorization
            requestInterceptor={request => {
              request.credentials = "same-origin";
              return request;
            }}
          />
        ) : (
          <div className="api-docs-loading" role="status">
            Loading API contract…
          </div>
        )}
      </section>
    </main>
  );
}
