import type { ReactNode } from "react";

export type IconName =
  | "alert-circle"
  | "arrow-left"
  | "arrow-right"
  | "car"
  | "check"
  | "clipboard"
  | "close"
  | "credit-card"
  | "download"
  | "file-text"
  | "help-circle"
  | "home"
  | "id-card"
  | "mail"
  | "message"
  | "moon"
  | "paperclip"
  | "plus"
  | "receipt"
  | "refresh"
  | "search"
  | "shield-check"
  | "sun"
  | "trash"
  | "truck"
  | "upload"
  | "wrench";

export function Icon({
  name,
  size = 20,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  const paths: Record<IconName, ReactNode> = {
    "alert-circle": <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 16h.01" />
    </>,
    "arrow-left": <path d="m15 18-6-6 6-6" />,
    "arrow-right": <path d="m9 18 6-6-6-6" />,
    car: <>
      <path d="M4 16v2.5a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5V12l2.2-5.3A2 2 0 0 1 6.05 5.5h11.9a2 2 0 0 1 1.85 1.2L22 12v6.5a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5V16" />
      <path d="M2 12h20" />
      <path d="M6.5 15h.01M17.5 15h.01" />
      <path d="M4 16h16" />
    </>,
    check: <path d="m5 12 4 4L19 6" />,
    clipboard: <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4.5V3h6v1.5M9 10h6M9 14h6M9 18h4" />
    </>,
    close: <path d="m7 7 10 10M17 7 7 17" />,
    "credit-card": <>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 10h19" />
      <path d="M6 14.5h4" />
    </>,
    download: <>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </>,
    "file-text": <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </>,
    "help-circle": <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.7 9a2.4 2.4 0 1 1 3.5 2.1c-.8.4-1.2.9-1.2 1.9M12 17h.01" />
    </>,
    home: <>
      <path d="m3 11 9-8 9 8" />
      <path d="M5 10v11h14V10M9 21v-7h6v7" />
    </>,
    "id-card": <>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <circle cx="8.5" cy="11" r="2.2" />
      <path d="M5 16.4c.7-1.4 2-2.1 3.5-2.1s2.8.7 3.5 2.1" />
      <path d="M15 10h4M15 13.5h4" />
    </>,
    mail: <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </>,
    message: <>
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
      <path d="M8 9h8M8 13h5" />
    </>,
    moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z" />,
    paperclip: <path d="M20 11.5 12.4 19a4.6 4.6 0 0 1-6.5-6.5l7.9-7.9a3 3 0 0 1 4.3 4.3l-7.9 7.9a1.5 1.5 0 0 1-2.1-2.1l7.2-7.2" />,
    plus: <path d="M12 5v14M5 12h14" />,
    receipt: <>
      <path d="M5 3.5v17l2.3-1.5 2.4 1.5 2.3-1.5 2.4 1.5 2.3-1.5 2 1.3V3.5Z" />
      <path d="M8.5 8.5h7M8.5 12.5h7M8.5 16h4" />
    </>,
    refresh: <>
      <path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5" />
      <path d="M4 4v4.5h4.5" />
      <path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.5" />
      <path d="M20 20v-4.5h-4.5" />
    </>,
    search: <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>,
    "shield-check": <>
      <path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" />
      <path d="m9 12 2 2 4-4" />
    </>,
    sun: <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </>,
    trash: <>
      <path d="M4 7h16" />
      <path d="M10 4h4M9 7v12M15 7v12" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </>,
    truck: <>
      <path d="M2 7h11v10H2Z" />
      <path d="M13 10h4.5l3.5 3.5V17h-8Z" />
      <circle cx="6.5" cy="18.5" r="1.8" />
      <circle cx="17" cy="18.5" r="1.8" />
    </>,
    wrench: <>
      <path d="M15.5 3a5.5 5.5 0 0 0-5 7.7L3.6 17.6a2 2 0 0 0 2.8 2.8l6.9-6.9A5.5 5.5 0 1 0 15.5 3Z" />
      <path d="M15.5 8.5h.01" />
    </>,
    upload: <>
      <path d="M12 20V8" />
      <path d="m7 13 5-5 5 5" />
      <path d="M5 4h14" />
    </>,
  };

  return (
    <svg
      aria-hidden="true"
      className={className ? `icon ${className}` : "icon"}
      fill="none"
      focusable="false"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      >
        {paths[name]}
      </g>
    </svg>
  );
}
