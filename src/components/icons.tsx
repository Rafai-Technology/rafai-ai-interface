/** 16px line icons, stroked in currentColor so they inherit state colours. */
const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const IconOperations = () => (
  <svg {...base}><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" /><path d="M3 7.5 12 12l9-4.5M12 12v9" /></svg>
);

export const IconAccounts = () => (
  <svg {...base}><path d="M6 4h12M6 9h12M9 4c4 0 6 1.6 6 4.2S12.6 13 9 13h6M9 13l6 7" /></svg>
);

export const IconFleet = () => (
  <svg {...base}><path d="M2 16V7h11v9M13 10h4l3 3.5V16" /><circle cx="7" cy="17.5" r="1.8" /><circle cx="17" cy="17.5" r="1.8" /></svg>
);

export const IconCrm = () => (
  <svg {...base}><path d="M4 13a8 8 0 0 1 16 0" /><rect x="2.5" y="13" width="4" height="6" rx="1.5" /><rect x="17.5" y="13" width="4" height="6" rx="1.5" /><path d="M19.5 19v.6a2.4 2.4 0 0 1-2.4 2.4H13" /></svg>
);

export const IconMis = () => (
  <svg {...base}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>
);

export const IconSales = () => (
  <svg {...base}><path d="M20.6 12.6 12 21.2l-8.5-8.5V3.8h8.9l8.2 8.2a1.2 1.2 0 0 1 0 1.7z" /><circle cx="8" cy="8" r="1.4" /></svg>
);

export const IconHr = () => (
  <svg {...base}><circle cx="9" cy="8" r="3.2" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M17 11.2A3 3 0 0 0 17 5M18.5 20a5.6 5.6 0 0 0-2.2-4.4" /></svg>
);

export const IconRoute = () => (
  <svg {...base}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.5 6H14a3.5 3.5 0 0 1 0 7h-4a3.5 3.5 0 0 0 0 7h5.5" /></svg>
);

export const IconPlus = () => (
  <svg {...base} width={13} height={13}><path d="M12 5v14M5 12h14" /></svg>
);

/* Outline when unpinned, filled when pinned — the state is the shape, not just
   a colour, so it survives a greyscale screenshot and a colour-blind reader. */
export const IconPin = ({ filled = false }: { filled?: boolean }) => (
  <svg {...base} width={13} height={13} fill={filled ? 'currentColor' : 'none'}>
    <path d="M9 4h6l-1 6 3 3H7l3-3-1-6Z" />
    <path d="M12 13v7" />
  </svg>
);

export const IconCopy = () => (
  <svg {...base} width={13} height={13}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>
);

export const IconCheck = () => (
  <svg {...base} width={13} height={13}><path d="M5 12.5 10 17.5 19 7" /></svg>
);

export const IconEdit = () => (
  <svg {...base} width={13} height={13}><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="M13.5 6.5 17.5 10.5" /></svg>
);

/* An arrow returning on itself: re-ask, not undo. */
export const IconRerun = () => (
  <svg {...base} width={13} height={13}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 5v6h-6" /></svg>
);

export const IconTrash = () => (
  <svg {...base} width={13} height={13}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
);

export const IconSend = () => (
  <svg {...base} width={17} height={17} strokeWidth={2}><path d="M12 19V5M5 12l7-7 7 7" /></svg>
);

export const IconPanel = () => (
  <svg {...base} width={16} height={16}>
    <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" />
  </svg>
);

export const IconMic = () => (
  <svg {...base} width={17} height={17}>
    <rect x="9" y="2" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);

export const IconStop = () => (
  <svg {...base} width={17} height={17}><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
);

export const IconAttach = () => (
  <svg {...base} width={17} height={17}>
    <path d="M21.44 11.05 12.25 20.24a5.5 5.5 0 0 1-7.78-7.78l9.2-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a1.5 1.5 0 0 1-2.12-2.12l8.49-8.48" />
  </svg>
);

export const IconFile = () => (
  <svg {...base} width={13} height={13}>
    <path d="M6 2h8l4 4v14a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 20V3.5A1.5 1.5 0 0 1 5.5 2z" />
    <path d="M14 2v4a1 1 0 0 0 1 1h4" />
  </svg>
);

export const IconClose = () => (
  <svg {...base} width={12} height={12} strokeWidth={2.2}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconDownload = () => (
  <svg {...base} width={14} height={14}>
    <path d="M12 3v12M6.5 10.5 12 16l5.5-5.5" />
    <path d="M4 19h16" />
  </svg>
);
