import { h } from './preact.js';

/**
 * A small, consistent stroke icon set. Every glyph is authored on the same
 * 24px grid so the UI keeps one optical weight.
 */
const PATHS = {
  lock: [
    ['rect', { x: 4.5, y: 10.5, width: 15, height: 10, rx: 2.5 }],
    ['path', { d: 'M8 10.5V7.8a4 4 0 0 1 8 0v2.7' }],
    ['circle', { cx: 12, cy: 15.5, r: 1.2, fill: 'currentColor', stroke: 'none' }]
  ],
  shield: [
    ['path', { d: 'M12 3.2 19 6v5.4c0 4.2-2.8 7.5-7 9.4-4.2-1.9-7-5.2-7-9.4V6l7-2.8Z' }],
    ['path', { d: 'm9 12 2.1 2.1L15.3 10' }]
  ],
  send: [
    ['path', { d: 'm4.5 11.4 14.7-7.1c.8-.4 1.6.5 1.2 1.3l-5.9 13.5c-.4.9-1.7.8-2-.2l-1.6-5-5-1.6c-1-.3-1.1-1.5-.2-1.9' }],
    ['path', { d: 'm10.7 13.2 4.2-4.2' }]
  ],
  paperclip: [
    ['path', { d: 'm20 11.5-7.6 7.6a5 5 0 0 1-7.1-7.1l8-8a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.8 1.8 0 0 1-2.6-2.6l7.3-7.3' }]
  ],
  smile: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M8.6 14.3c.8 1.2 2 1.9 3.4 1.9s2.6-.7 3.4-1.9' }],
    ['circle', { cx: 9.3, cy: 9.8, r: .8, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 14.7, cy: 9.8, r: .8, fill: 'currentColor', stroke: 'none' }]
  ],
  'arrow-left': [
    ['path', { d: 'M19 12H5' }],
    ['path', { d: 'm11 6-6 6 6 6' }]
  ],
  more: [
    ['circle', { cx: 5.5, cy: 12, r: 1.4, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 12, cy: 12, r: 1.4, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 18.5, cy: 12, r: 1.4, fill: 'currentColor', stroke: 'none' }]
  ],
  settings: [
    ['circle', { cx: 12, cy: 12, r: 3 }],
    ['path', { d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.4 15a1.7 1.7 0 0 0-1.5-1H2.7a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.4 8.9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V2.7a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z' }]
  ],
  plus: [
    ['path', { d: 'M12 5v14M5 12h14' }]
  ],
  check: [
    ['path', { d: 'm5 12.5 4.5 4.5L19 7.5' }]
  ],
  'check-double': [
    ['path', { d: 'm2.5 12.5 4 4L15 8' }],
    ['path', { d: 'm10.5 16 1.5 1.5L22 7' }]
  ],
  clock: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M12 7.5V12l3 1.8' }]
  ],
  copy: [
    ['rect', { x: 8.5, y: 8.5, width: 11.5, height: 11.5, rx: 2.4 }],
    ['path', { d: 'M15.5 8.5V6.2A2.2 2.2 0 0 0 13.3 4H6.2A2.2 2.2 0 0 0 4 6.2v7.1a2.2 2.2 0 0 0 2.2 2.2h2.3' }]
  ],
  reply: [
    ['path', { d: 'M9.5 6.5 4 12l5.5 5.5' }],
    ['path', { d: 'M4 12h8.5a7.5 7.5 0 0 1 7.5 7.5' }]
  ],
  edit: [
    ['path', { d: 'M13.5 5.5 18.5 10.5' }],
    ['path', { d: 'm4 20 4.2-1 10.6-10.6a2.8 2.8 0 0 0-4-4L4.2 15 4 20Z' }]
  ],
  trash: [
    ['path', { d: 'M4.5 7h15' }],
    ['path', { d: 'M9 7V5.3A1.3 1.3 0 0 1 10.3 4h3.4A1.3 1.3 0 0 1 15 5.3V7' }],
    ['path', { d: 'M6.5 7l.8 12.1A1.5 1.5 0 0 0 8.8 20.5h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7' }],
    ['path', { d: 'M10 11v5.5M14 11v5.5' }]
  ],
  image: [
    ['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }],
    ['circle', { cx: 9, cy: 9.5, r: 1.5 }],
    ['path', { d: 'm5 17 4.5-4.5 3.5 3.5 2.5-2.5L20 18' }]
  ],
  video: [
    ['rect', { x: 3, y: 6, width: 13, height: 12, rx: 2.5 }],
    ['path', { d: 'm16 10.5 4-2.2v7.4l-4-2.2' }]
  ],
  download: [
    ['path', { d: 'M12 4v11' }],
    ['path', { d: 'm7.5 10.5 4.5 4.5 4.5-4.5' }],
    ['path', { d: 'M5 19.5h14' }]
  ],
  x: [
    ['path', { d: 'M6 6l12 12M18 6 6 18' }]
  ],
  phone: [
    ['path', { d: 'M6.2 3.5h3l1.4 4-2 1.4a14 14 0 0 0 6.5 6.5l1.4-2 4 1.4v3a2 2 0 0 1-2.1 2A16.8 16.8 0 0 1 4.2 5.6a2 2 0 0 1 2-2.1Z' }]
  ],
  link: [
    ['path', { d: 'M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7L11.5 6.8' }],
    ['path', { d: 'M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.3-1.3' }]
  ],
  share: [
    ['circle', { cx: 18, cy: 5.5, r: 2.5 }],
    ['circle', { cx: 6, cy: 12, r: 2.5 }],
    ['circle', { cx: 18, cy: 18.5, r: 2.5 }],
    ['path', { d: 'm8.2 10.8 7.6-4M8.2 13.2l7.6 4' }]
  ],
  bell: [
    ['path', { d: 'M6 9.5a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6Z' }],
    ['path', { d: 'M10 19a2.2 2.2 0 0 0 4 0' }]
  ],
  'bell-off': [
    ['path', { d: 'M6 9.5a6 6 0 0 1 9.5-4.7M18 9.5c0 4 1.5 5.5 2 6H9.5' }],
    ['path', { d: 'M4 19h16' }],
    ['path', { d: 'm4 4 16 16' }],
    ['path', { d: 'M10 19a2.2 2.2 0 0 0 4 0' }]
  ],
  user: [
    ['circle', { cx: 12, cy: 8, r: 4 }],
    ['path', { d: 'M4.5 20a7.5 7.5 0 0 1 15 0' }]
  ],
  users: [
    ['circle', { cx: 9, cy: 8, r: 3.5 }],
    ['path', { d: 'M2.5 19a6.5 6.5 0 0 1 13 0' }],
    ['path', { d: 'M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14a5.5 5.5 0 0 1 3.5 5' }]
  ],
  key: [
    ['circle', { cx: 8, cy: 15, r: 4 }],
    ['path', { d: 'm11 12 8.5-8.5M16 7l2 2M13.5 9.5l2 2' }]
  ],
  moon: [
    ['path', { d: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z' }]
  ],
  sun: [
    ['circle', { cx: 12, cy: 12, r: 4 }],
    ['path', { d: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' }]
  ],
  monitor: [
    ['rect', { x: 3, y: 4.5, width: 18, height: 12, rx: 2 }],
    ['path', { d: 'M8.5 20h7M12 16.5V20' }]
  ],
  'log-out': [
    ['path', { d: 'M10 4.5H6.5A2.5 2.5 0 0 0 4 7v10a2.5 2.5 0 0 0 2.5 2.5H10' }],
    ['path', { d: 'M14 8l4 4-4 4M8.5 12H18' }]
  ],
  alert: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M12 7.5v5.5' }],
    ['circle', { cx: 12, cy: 16.5, r: 1, fill: 'currentColor', stroke: 'none' }]
  ],
  'wifi-off': [
    ['path', { d: 'M3 4l18 18' }],
    ['path', { d: 'M8.5 12.8a6 6 0 0 1 7 0M5.5 9.4a11 11 0 0 1 13 0M2.5 6a16 16 0 0 1 5-2.4M21.5 6a16 16 0 0 0-4.2-2.2' }],
    ['circle', { cx: 12, cy: 18.5, r: 1.2, fill: 'currentColor', stroke: 'none' }]
  ],
  refresh: [
    ['path', { d: 'M20 11a8 8 0 0 0-14.9-3.5L3 10' }],
    ['path', { d: 'M3 4v6h6' }],
    ['path', { d: 'M4 13a8 8 0 0 0 14.9 3.5L21 14' }],
    ['path', { d: 'M21 20v-6h-6' }]
  ],
  eye: [
    ['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z' }],
    ['circle', { cx: 12, cy: 12, r: 3 }]
  ],
  'eye-off': [
    ['path', { d: 'M3 3l18 18' }],
    ['path', { d: 'M10.6 6.1A10 10 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3 3.6M6.6 6.6C4 8.3 2.5 12 2.5 12S6 18 12 18a9.9 9.9 0 0 0 4.4-1' }],
    ['path', { d: 'M9.9 9.9a3 3 0 0 0 4.2 4.2' }]
  ],
  'chevron-down': [
    ['path', { d: 'm6 9 6 6 6-6' }]
  ],
  'chevron-right': [
    ['path', { d: 'm9 6 6 6-6 6' }]
  ],
  camera: [
    ['path', { d: 'M4 8.5h2.5L8 5.8h8l1.5 2.7H20a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18v-8A1.5 1.5 0 0 1 4 8.5Z' }],
    ['circle', { cx: 12, cy: 14, r: 3.2 }]
  ],
  fingerprint: [
    ['path', { d: 'M5.5 10a7 7 0 0 1 13 0' }],
    ['path', { d: 'M8 12a4.2 4.2 0 0 1 8 0c0 3.5-.8 6-2.2 8' }],
    ['path', { d: 'M11 13.5c0 3-.5 4.8-1.2 6' }],
    ['path', { d: 'M14 13.5c0 2.4-.4 4.2-1 5.6' }]
  ],
  sparkle: [
    ['path', { d: 'm12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z' }],
    ['path', { d: 'm18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z' }]
  ],
  message: [
    ['path', { d: 'M20.5 11.5a8.5 8.5 0 0 1-12.2 7.6L3.5 20.5l1.4-4.6A8.5 8.5 0 1 1 20.5 11.5Z' }],
    ['path', { d: 'M8.5 11.5h7M8.5 14.5h4.5' }]
  ],
  ban: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'm6 18 12-12' }]
  ],
  search: [
    ['circle', { cx: 11, cy: 11, r: 6.5 }],
    ['path', { d: 'm16 16 4.5 4.5' }]
  ],
  info: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M12 11v5.5' }],
    ['circle', { cx: 12, cy: 8, r: 1, fill: 'currentColor', stroke: 'none' }]
  ],
  'shield-check': [
    ['path', { d: 'M12 3.2 19 6v5.4c0 4.2-2.8 7.5-7 9.4-4.2-1.9-7-5.2-7-9.4V6l7-2.8Z' }],
    ['path', { d: 'm8.6 12 2.3 2.3 4.5-4.6' }]
  ],
  palette: [
    ['path', { d: 'M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2.2-.9 2.2-2 0-1.4-1.2-1.7-1.2-3 0-1 .8-1.8 1.8-1.8h2A3.7 3.7 0 0 0 20.5 10c0-3.7-3.8-6.5-8.5-6.5Z' }],
    ['circle', { cx: 8, cy: 9, r: 1, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 12, cy: 7, r: 1, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 16, cy: 9, r: 1, fill: 'currentColor', stroke: 'none' }]
  ],
  smartphone: [
    ['rect', { x: 6.5, y: 2.5, width: 11, height: 19, rx: 2.5 }],
    ['path', { d: 'M10.5 18.5h3' }]
  ],
  'arrow-right': [
    ['path', { d: 'M5 12h14' }],
    ['path', { d: 'm13 6 6 6-6 6' }]
  ],
  'volume-off': [
    ['path', { d: 'M5 9.5v5h3l4 3.5V6L8 9.5H5Z' }],
    ['path', { d: 'm16 9 5 6M21 9l-5 6' }]
  ],
  restore: [
    ['path', { d: 'M4 5v5h5' }],
    ['path', { d: 'M4.7 10A8 8 0 1 1 4 14' }]
  ]
};

export function Icon({ name, size = 20, className = '', strokeWidth = 1.7, ...rest }) {
  const glyph = PATHS[name] || PATHS.info;
  return h(
    'svg',
    {
      class: `icon ${className}`.trim(),
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': strokeWidth,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
      ...rest
    },
    glyph.map(([tag, props], index) => h(tag, { key: index, ...props }))
  );
}

let logoSeq = 0;

/**
 * The Duet brand mark — the same artwork as the installed app icon, drawn as
 * inline SVG so it stays sharp at every size and needs no image request.
 */
export function LogoMark({ size = 34, className = '' }) {
  const id = `duet-mark-${++logoSeq}`;
  return h(
    'svg',
    {
      class: `logo-mark ${className}`.trim(),
      width: size,
      height: size,
      viewBox: '0 0 64 64',
      'aria-hidden': 'true',
      focusable: 'false'
    },
    [
      h('defs', {}, [
        h('linearGradient', { id: `${id}-plate`, x1: '0', y1: '0', x2: '1', y2: '1' }, [
          h('stop', { offset: '0', 'stop-color': '#F9FAFE' }),
          h('stop', { offset: '.55', 'stop-color': '#ECEEF6' }),
          h('stop', { offset: '1', 'stop-color': '#DDE0EE' })
        ]),
        h('linearGradient', { id: `${id}-violet`, x1: '0', y1: '0', x2: '1', y2: '1' }, [
          h('stop', { offset: '0', 'stop-color': '#7A47FF' }),
          h('stop', { offset: '1', 'stop-color': '#6130E8' })
        ])
      ]),
      h('rect', { width: 64, height: 64, rx: 16, fill: `url(#${id}-plate)` }),
      h('rect', {
        x: 11.5, y: 13.5, width: 21, height: 37, rx: 7.5,
        fill: '#FFFFFF', stroke: '#1A1C2E', 'stroke-opacity': '.07', 'stroke-width': '.75'
      }),
      h('path', {
        fill: `url(#${id}-violet)`,
        d: 'M33 13h8a17 17 0 0 1 0 34h-4l-3.6 5.2L30 47h-2.5z'
      }),
      h('path', { fill: '#15161F', d: 'M23 32 30 24.5h8.5a8.75 8.75 0 0 1 0 17.5H30Z' }),
      h('circle', { cx: 28.2, cy: 33.2, r: 1.9, fill: '#7A47FF' }),
      h('circle', { cx: 33.6, cy: 33.2, r: 1.9, fill: '#FFFFFF' }),
      h('circle', { cx: 39, cy: 33.2, r: 1.9, fill: '#7A47FF' })
    ]
  );
}
