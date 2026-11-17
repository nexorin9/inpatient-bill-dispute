/* ==========================================================================
   内联 SVG 图标 —— 收费员工作台
   全部为线性图标：fill="none" / stroke="currentColor"，颜色由容器 color 决定，
   不含 emoji、不含任何裸色值。统一 viewBox 0 0 24 24，尺寸由 .icon 类控制。
   ========================================================================== */

const svg = (body: string): string =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const iconWorkbench = (): string => svg(
  '<rect x="3" y="3" width="7" height="18" rx="1.5"/><rect x="14" y="3" width="7" height="8" rx="1.5"/><rect x="14" y="13" width="7" height="8" rx="1.5"/>'
);
export const iconSettings = (): string => svg(
  '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2 2-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-2.8v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-2-2 .1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H4v-2.8h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2-2 .1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V4h2.8v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 2 2-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2v2.8h-.2a1.7 1.7 0 0 0-1.5 1z"/>'
);
export const iconSearch = (): string => svg(
  '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/>'
);
export const iconRefresh = (): string => svg(
  '<path d="M20 11a8 8 0 0 0-13.7-5.1L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 13.7 5.1L20 16"/><path d="M20 20v-4h-4"/>'
);
export const iconChevronDown = (): string => svg('<path d="M6 9l6 6 6-6"/>');
export const iconChevronRight = (): string => svg('<path d="M9 6l6 6-6 6"/>');
export const iconCheck = (): string => svg('<path d="M4 12l5 5L20 6"/>');
export const iconPrint = (): string => svg(
  '<path d="M6 9V3h12v6"/><rect x="6" y="14" width="12" height="7" rx="1"/><path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><path d="M18 13h.01"/>'
);
export const iconSend = (): string => svg(
  '<path d="M4 12l16-8-6 16-2.5-6.5L4 12z"/><path d="M11.5 13.5L20 4"/>'
);
export const iconReplay = (): string => svg(
  '<path d="M3 11a9 9 0 1 1 2.6 6.4"/><path d="M3 4v7h7"/>'
);
export const iconWarning = (): string => svg(
  '<path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'
);
export const iconInfo = (): string => svg(
  '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>'
);
export const iconClose = (): string => svg('<path d="M18 6L6 18M6 6l12 12"/>');
export const iconShield = (): string => svg(
  '<path d="M12 3l8 3v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-3z"/><path d="M9 12l2 2 4-4"/>'
);
export const iconFileText = (): string => svg(
  '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>'
);
export const iconClock = (): string => svg(
  '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
);
export const iconUser = (): string => svg(
  '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'
);
export const iconFilter = (): string => svg(
  '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5z"/>'
);
export const iconServer = (): string => svg(
  '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>'
);
export const iconKey = (): string => svg(
  '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3l1 1-2.5 2.5L21 9l-2 2-2.5-2.5L14 11"/>'
);
export const iconDownload = (): string => svg(
  '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>'
);
export const iconAlertCircle = (): string => svg(
  '<circle cx="12" cy="12" r="9"/><path d="M12 7v5"/><path d="M12 16h.01"/>'
);
export const iconCheckCircle = (): string => svg(
  '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>'
);
export const iconExternal = (): string => svg(
  '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/>'
);
export const iconLock = (): string => svg(
  '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 15v2"/>'
);
export const iconInbox = (): string => svg(
  '<path d="M4 4h16l2 9v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6L4 4z"/><path d="M2 13h6l1 3h6l1-3h6"/>'
);
export const iconLayers = (): string => svg(
  '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 17l9 5 9-5"/>'
);
