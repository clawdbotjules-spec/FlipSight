/** Hand-drawn 24px stroke icons — no icon library, keeps the bundle lean. */

type IconProps = React.SVGProps<SVGSVGElement>;

function base(props: IconProps) {
  return {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...props,
  };
}

export const RadarIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="4.5" opacity="0.5" />
    <path d="M12 12 L18.4 5.6" />
    <circle cx="16" cy="9" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

export const ChartIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 20h18" />
    <path d="M6 16v-5M11 16V7M16 16v-3M21 16V4" opacity="0.9" />
  </svg>
);

export const NodesIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="5" cy="6" r="2.2" />
    <circle cx="19" cy="6" r="2.2" />
    <circle cx="12" cy="18" r="2.2" />
    <path d="M6.8 7.4 10.6 16M17.2 7.4 13.4 16M7.2 6h9.6" opacity="0.7" />
  </svg>
);

export const SparkIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M13 2 5 13h6l-1 9 8-11h-6l1-9z" />
  </svg>
);

export const PulseIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M2 12h4l2.5-7 4 14 2.5-7H22" />
  </svg>
);

export const ExternalIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M14 4h6v6" />
    <path d="M20 4 10.5 13.5" />
    <path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />
  </svg>
);

export const CheckIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m4.5 12.5 5 5L19.5 7" />
  </svg>
);

export const XIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const PenIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 20l1-4L17.5 3.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z" />
    <path d="M15 6l3 3" opacity="0.7" />
  </svg>
);

export const ClockIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </svg>
);

export const CopyIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </svg>
);

export const CameraIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8z" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
);

export const WarnIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3 2.5 20h19L12 3z" />
    <path d="M12 10v4.5" />
    <circle cx="12" cy="17.2" r="0.4" fill="currentColor" />
  </svg>
);

export const LogoMark = (p: IconProps) => (
  <svg {...base({ strokeWidth: 2, ...p })}>
    <path d="M4 15 9 6l4 6 3.5-4L20 12" />
    <path d="M4 19h16" opacity="0.4" />
    <circle cx="20" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);
