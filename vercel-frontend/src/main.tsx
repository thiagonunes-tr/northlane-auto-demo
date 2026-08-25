import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ApiDocs from "../../shared/ApiDocs";
import NorthlaneApp from "../../shared/NorthlaneApp";
import "../../app/globals.css";

const isApiDocs = /^\/api-docs\/?$/.test(window.location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isApiDocs ? <ApiDocs /> : <NorthlaneApp />}
  </StrictMode>,
);
