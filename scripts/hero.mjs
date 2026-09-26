#!/usr/bin/env node
/**
 * hero.mjs — renders the profile hero banner: an isometric landscape of the last year of
 * contributions, standing on the liquid-glass backdrop, with a glass pane that REFRACTS the
 * terrain behind it.
 *
 * Everything is one self-contained SVG: no external fonts, images, scripts or <foreignObject>,
 * because GitHub serves README images through its camo proxy as <img>, where an SVG is a sealed
 * document. Only inline geometry plus SMIL/CSS animation survives that.
 *
 * Fallback discipline: every animation is additive. Base attribute values are the FINAL state, so
 * a renderer with no SMIL and no CSS animation still shows the finished banner rather than a blank
 * or half-drawn one.
 *
 * Env:  GH_TOKEN | GITHUB_TOKEN  (required)   GH_USER (default: rezzminator)
 * Out:  assets/hero-dark.svg, assets/hero-light.svg
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- tunables

const W = 1200;
const H = 440;

/** Flattened isometric. True 2:1 iso would be ~560px tall for 53 weeks; this keeps it banner-shaped. */
const ISO = {
  ax: 17.6, // half-width of a tile: screen x = (col - row) * ax
  by: 4.5, //  half-height of a tile: screen y = (col + row) * by
  minBar: 3, //  extrusion of a 1-contribution day
  maxBar: 46, // extrusion of the busiest day
  originX: 175,
  originY: 112,
};

const THEMES = {
  dark: {
    bg: '#0d1117',
    smokeTint: [0.62, 0.78, 0.86],
    levels: ['#161b22', '#1e3a5f', '#2a5a9f', '#4a86e8', '#7aa2f7'],
    paneInk: '#e6edf3',
    paneBack: 0.58,
    accent: '#7aa2f7',
    typed: '#9ece6a',
    caption: '#9fb0c0',
    muted: '#8b949e',
    kicker: '#7dcfff',
    bevelStop: '#ffffff',
    paneFill: 0.04,
    grid: '#30363d',
  },
  light: {
    bg: '#ffffff',
    smokeTint: [0.36, 0.55, 0.78],
    levels: ['#f0f3f6', '#c6e0ff', '#8fc0f8', '#4a90f0', '#1257c4'],
    paneInk: '#1f2328',
    paneBack: 0.55,
    accent: '#0969da',
    typed: '#1a7f37',
    caption: '#424a53',
    muted: '#59636e',
    kicker: '#0969da',
    bevelStop: '#0969da',
    paneFill: 0.3,
    grid: '#d0d7de',
  },
};

const LEVEL_INDEX = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

/**
 * Face shading, per theme. Shading multiplies toward black, which desaturates a light palette into
 * grey — so the light theme gets a much gentler falloff than the dark one.
 */
const SHADE = {
  dark: { top: 1, left: 0.62, right: 0.44 },
  light: { top: 1, left: 0.86, right: 0.72 },
};

// ---------------------------------------------------------------- helpers

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

const r2 = (n) => Math.round(n * 100) / 100;

function shade(hex, f) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => Math.max(0, Math.min(255, Math.round(x * f))));
  return '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- data

async function gql(token, query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-hero-generator',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  if (!body.data?.user) throw new Error(`GraphQL: no user ${variables.login}`);
  return body.data;
}

const CALENDAR_QUERY = `
query Calendar($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays { contributionCount weekday contributionLevel }
        }
      }
    }
  }
}`;

async function fetchCalendar(token, login) {
  const d = await gql(token, CALENDAR_QUERY, { login });
  const cal = d.user.contributionsCollection.contributionCalendar;
  const cells = [];
  cal.weeks.forEach((week, col) => {
    for (const day of week.contributionDays) {
      cells.push({
        col,
        row: day.weekday,
        count: day.contributionCount,
        level: LEVEL_INDEX[day.contributionLevel] ?? 0,
      });
    }
  });
  return { total: cal.totalContributions, cells, weeks: cal.weeks.length };
}

// ---------------------------------------------------------------- terrain

/**
 * One extruded cell. Painter's algorithm: callers must emit cells ordered by (col + row) ascending
 * so nearer blocks overdraw farther ones.
 */
function block(cell, t, maxCount, sh) {
  const { ax, by, minBar, maxBar, originX, originY } = ISO;
  const x = originX + (cell.col - cell.row) * ax;
  const y = originY + (cell.col + cell.row) * by;
  const h =
    cell.count === 0 ? 0 : minBar + (maxBar - minBar) * (Math.log1p(cell.count) / Math.log1p(maxCount));

  const base = t.levels[cell.level];
  const top = shade(base, sh.top);
  const ptsTop = `${r2(x)},${r2(y - h)} ${r2(x + ax)},${r2(y - h + by)} ${r2(x)},${r2(y - h + 2 * by)} ${r2(x - ax)},${r2(y - h + by)}`;

  if (h === 0) return `<polygon points="${ptsTop}" fill="${top}"/>`;

  // left face (facing viewer-left) and right face, both dropping from the top rhombus to the base
  const left = `${r2(x - ax)},${r2(y - h + by)} ${r2(x)},${r2(y - h + 2 * by)} ${r2(x)},${r2(y + 2 * by)} ${r2(x - ax)},${r2(y + by)}`;
  const right = `${r2(x)},${r2(y - h + 2 * by)} ${r2(x + ax)},${r2(y - h + by)} ${r2(x + ax)},${r2(y + by)} ${r2(x)},${r2(y + 2 * by)}`;

  return (
    `<polygon points="${left}" fill="${shade(base, sh.left)}"/>` +
    `<polygon points="${right}" fill="${shade(base, sh.right)}"/>` +
    `<polygon points="${ptsTop}" fill="${top}"/>`
  );
}

function terrain(cells, t, maxCount, sh) {
  // group by week so each column can rise with its own stagger
  const byCol = new Map();
  for (const c of cells) {
    if (!byCol.has(c.col)) byCol.set(c.col, []);
    byCol.get(c.col).push(c);
  }
  const cols = [...byCol.keys()].sort((a, b) => a - b);
  return cols
    .map((col) => {
      const inner = byCol
        .get(col)
        .sort((a, b) => a.col + a.row - (b.col + b.row))
        .map((c) => block(c, t, maxCount, sh))
        .join('');
      // delay grows left-to-right; `both` fill-mode means no-animation renderers show the end state
      return `<g class="wk" style="animation-delay:${r2(col * 0.014)}s">${inner}</g>`;
    })
    .join('\n    ');
}

// ---------------------------------------------------------------- svg

function render(login, data, themeName) {
  const t = THEMES[themeName];
  const maxCount = Math.max(1, ...data.cells.map((c) => c.count));
  const paneX = 60;
  const paneY = 186;
  const paneW = 470;
  const paneH = 150;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="hero-title">
  <title id="hero-title">${esc(login)} — ${data.total.toLocaleString('en-US')} contributions in the last year, drawn as an isometric landscape behind a pane of glass.</title>
  <defs>
    <filter id="smoke" x="-30%" y="-60%" width="160%" height="220%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.0032 0.0065" numOctaves="4" seed="11" result="n">
        <animate attributeName="baseFrequency" values="0.0032 0.0065;0.0040 0.0075;0.0032 0.0065" dur="26s" repeatCount="indefinite"/>
      </feTurbulence>
      <feOffset in="n" dx="0" dy="0" result="drift">
        <animate attributeName="dx" values="0;-260" dur="60s" repeatCount="indefinite"/>
        <animate attributeName="dy" values="0;-40;0" dur="37s" repeatCount="indefinite"/>
      </feOffset>
      <feColorMatrix in="drift" type="matrix" values="
        0 0 0 0 ${t.smokeTint[0]}
        0 0 0 0 ${t.smokeTint[1]}
        0 0 0 0 ${t.smokeTint[2]}
        0 0 0 2.6 -1.05" result="tinted"/>
      <feGaussianBlur in="tinted" stdDeviation="1.2"/>
    </filter>

    <!-- the pane's refraction: displaces a copy of the backdrop, terrain included -->
    <filter id="glass" x="-12%" y="-12%" width="124%" height="124%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.012 0.02" numOctaves="2" seed="4" result="rn">
        <animate attributeName="seed" values="4;5;6;7;8;9;10;11;12;13;14;15;4" dur="30s" repeatCount="indefinite" calcMode="discrete"/>
      </feTurbulence>
      <feDisplacementMap in="SourceGraphic" in2="rn" scale="20" xChannelSelector="R" yChannelSelector="G"/>
      <feGaussianBlur stdDeviation="2.2"/>
      <feComponentTransfer>
        <feFuncR type="linear" slope="1.22" intercept="0.04"/>
        <feFuncG type="linear" slope="1.22" intercept="0.05"/>
        <feFuncB type="linear" slope="1.22" intercept="0.06"/>
      </feComponentTransfer>
    </filter>

    <radialGradient id="vig" cx="0.5" cy="0.45" r="0.78">
      <stop offset="0.5" stop-color="${t.bg}" stop-opacity="0"/>
      <stop offset="1" stop-color="${t.bg}" stop-opacity="0.92"/>
    </radialGradient>
    <linearGradient id="bevel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.bevelStop}" stop-opacity="0.55"/>
      <stop offset="0.35" stop-color="${t.bevelStop}" stop-opacity="0.08"/>
      <stop offset="0.7" stop-color="${t.bevelStop}" stop-opacity="0.05"/>
      <stop offset="1" stop-color="${t.bevelStop}" stop-opacity="0.35"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>

    <clipPath id="paneClip"><rect x="${paneX}" y="${paneY}" width="${paneW}" height="${paneH}" rx="20"/></clipPath>
    <clipPath id="typeClip">
      <rect x="${paneX + 30}" y="${paneY + 86}" width="400" height="34">
        <animate attributeName="width" values="0;0;400;400;0;0" keyTimes="0;0.05;0.35;0.82;0.93;1" dur="10s" repeatCount="indefinite" calcMode="spline" keySplines="0 0 1 1;0.2 0 0.8 1;0 0 1 1;0.4 0 0.6 1;0 0 1 1"/>
      </rect>
    </clipPath>

    <!-- backdrop = smoke + terrain, referenced twice: once plain, once refracted through the pane -->
    <g id="backdrop">
      <rect x="-200" y="-120" width="${W + 400}" height="${H + 240}" fill="${t.bg}" filter="url(#smoke)" opacity="0.85"/>
      <g class="terrain">
    ${terrain(data.cells, t, maxCount, SHADE[themeName])}
      </g>
    </g>

    <style>
      .mono { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; }
      .sans { font-family: 'Segoe UI', Ubuntu, 'Helvetica Neue', Helvetica, Arial, sans-serif; }
      .wk   { animation: rise .7s cubic-bezier(.22,.9,.28,1) both; }
      @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      .fade { animation: fadein 1.1s ease-out both; }
      .d1 { animation-delay: .55s } .d2 { animation-delay: .75s } .d3 { animation-delay: .95s }
      @keyframes fadein { from { opacity: 0 } to { opacity: 1 } }
      .cursor { animation: blink 1.1s steps(2, start) infinite; }
      @keyframes blink { to { visibility: hidden } }
      @media (prefers-reduced-motion: reduce) { .wk, .fade, .cursor { animation: none } }
    </style>
  </defs>

  <rect width="${W}" height="${H}" fill="${t.bg}"/>
  <use href="#backdrop"/>
  <rect width="${W}" height="${H}" fill="url(#vig)"/>

  <!-- glass pane: a refracted copy of the same backdrop, then the bevel and the ink -->
  <g clip-path="url(#paneClip)" filter="url(#glass)" opacity="0.92"><use href="#backdrop"/></g>
  <rect x="${paneX}" y="${paneY}" width="${paneW}" height="${paneH}" rx="20" fill="${t.bg}" fill-opacity="${t.paneBack}"/>
  <rect x="${paneX}" y="${paneY}" width="${paneW}" height="${paneH}" rx="20" fill="#ffffff" fill-opacity="${t.paneFill}" stroke="url(#bevel)" stroke-width="1.5"/>
  <rect x="${paneX + 1.5}" y="${paneY + 1.5}" width="${paneW - 3}" height="${paneH - 3}" rx="19" fill="none" stroke="${t.bevelStop}" stroke-opacity="0.08"/>
  <rect x="${paneX}" y="${paneY}" width="${paneW}" height="6" rx="3" fill="url(#sheen)"/>

  <text x="${paneX + 30}" y="${paneY + 34}" class="mono" font-size="13" fill="${t.accent}">~ $ whoami</text>
  <text x="${paneX + 30}" y="${paneY + 74}" class="sans" font-size="38" font-weight="700" fill="${t.paneInk}">hi, i'm reza</text>
  <g clip-path="url(#typeClip)">
    <text x="${paneX + 30}" y="${paneY + 110}" class="mono" font-size="17" fill="${t.typed}">ai pipelines · langchain / langgraph / rag</text>
  </g>
  <rect class="cursor" x="${paneX + 30 + 388}" y="${paneY + 96}" width="9" height="19" fill="${t.typed}">
    <animate attributeName="x" values="${paneX + 30};${paneX + 30};${paneX + 418};${paneX + 418};${paneX + 30};${paneX + 30}" keyTimes="0;0.05;0.35;0.82;0.93;1" dur="10s" repeatCount="indefinite" calcMode="spline" keySplines="0 0 1 1;0.2 0 0.8 1;0 0 1 1;0.4 0 0.6 1;0 0 1 1"/>
  </rect>
  <text x="${paneX + 30}" y="${paneY + 136}" class="mono" font-size="12" fill="${t.muted}">booking.com · the netherlands · go / rust / python</text>

  <!-- the terrain, captioned -->
  <text x="${W - 60}" y="60" class="mono fade d1" font-size="12" letter-spacing="3" text-anchor="end" fill="${t.kicker}">THE LAST YEAR, EXTRUDED</text>
  <text x="${W - 60}" y="94" class="sans fade d2" font-size="30" font-weight="700" text-anchor="end" fill="${t.paneInk}">${data.total.toLocaleString('en-US')} contributions</text>
  <text x="${W - 60}" y="${H - 30}" class="mono fade d3" font-size="11" text-anchor="end" fill="${t.muted}">every block is a day · redrawn daily from the contribution graph</text>
</svg>
`;
}

// ---------------------------------------------------------------- main

async function main() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('set GH_TOKEN or GITHUB_TOKEN');
  const login = process.env.GH_USER || 'rezzminator';

  const data = await fetchCalendar(token, login);
  const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
  await fs.mkdir(outDir, { recursive: true });

  for (const theme of Object.keys(THEMES)) {
    const file = path.join(outDir, `hero-${theme}.svg`);
    await fs.writeFile(file, render(login, data, theme), 'utf8');
  }

  const busiest = Math.max(...data.cells.map((c) => c.count));
  console.log(
    `hero: ${login} weeks=${data.weeks} cells=${data.cells.length} total=${data.total} busiestDay=${busiest}`,
  );
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
