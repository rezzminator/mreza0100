#!/usr/bin/env node
/**
 * stats.mjs — self-hosted GitHub stats card generator.
 *
 * Reads PUBLIC profile numbers from the GitHub GraphQL API and renders them as two
 * self-contained SVG cards: assets/stats-dark.svg and assets/stats-light.svg.
 * Zero dependencies, Node >= 20 (global fetch).
 *
 *   GH_TOKEN  auth token (fallback: GITHUB_TOKEN) — the default Actions token is enough
 *   GH_USER   login to render (default: rezzminator)
 *
 * Output is deterministic — no timestamps, stable sort order, fixed number formatting —
 * so a rerun with unchanged data yields byte-identical files and the workflow only
 * commits on a real diff.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ───────────────────────────────────────────────────────────── configuration ──

/** Colour themes — retune here. Both cards share LAYOUT below. */
const THEMES = {
  // Tokyo-Night-inspired
  dark: {
    bg: '#1a1b26', border: '#2f3549', title: '#7aa2f7', text: '#c0caf5',
    muted: '#565f89', number: '#e0af68', icon: '#7dcfff', barTrack: '#24283b',
  },
  // GitHub-light-inspired
  light: {
    bg: '#ffffff', border: '#d0d7de', title: '#0969da', text: '#1f2328',
    muted: '#656d76', number: '#953800', icon: '#0969da', barTrack: '#eaeef2',
  },
};

const FONT_TEXT = "'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif";
const FONT_MONO = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";
const LANG_FALLBACK_COLOR = '#8b949e';
const TOP_LANGS = 6;

/** Geometry in SVG user units (px). Legend rows share the left column's baselines. */
const LAYOUT = {
  width: 495, height: 212, radius: 10,
  padX: 20, titleY: 35,
  rowY: 70, rowPitch: 28,            // baseline of row 0, distance between row baselines
  icon: 16, labelX: 44, numX: 246,   // left column: icon at padX, label start, number right edge
  rightX: 264, rightW: 211,          // right column origin and width
  barY: 88, barH: 8,                 // stacked language bar
  legendCols: 2, legendGutter: 8,    // legend grid (rows share the left column's baselines)
  font: { title: 18, label: 12, num: 12, section: 12, legend: 11, pct: 10 },
};

/** Animation timing (seconds). Everything settles well under 2s. */
const ANIM = { rowDuration: 0.45, rowBase: 0.15, rowStagger: 0.2, barDuration: 0.8, barBase: 0.35, barStagger: 0.06 };

/** 16px stroke icons, Octicon-style, hand-drawn (no external assets). */
const ICONS = {
  star: 'M8 1.8L9.7 6.05 14.28 6.36 10.76 9.3 11.88 13.74 8 11.3 4.12 13.74 5.24 9.3 1.72 6.36 6.3 6.05z',
  repo: 'M4.5 1.5h8v10.2H5a1.5 1.5 0 0 0 0 3h7.5M4.5 1.5a1 1 0 0 0-1 1V13M6.5 4.5h4',
  commit: 'M1.5 8h3.7M10.8 8h3.7M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z',
  graph: 'M1.5 14.5h13M4.5 12V8M8 12V3.5M11.5 12V6',
  people: 'M5.5 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM1.5 13.5a4 4 0 0 1 8 0M10.5 3a2.2 2.2 0 0 1 0 4.2M12.2 9.6a3.6 3.6 0 0 1 2.3 3.9',
  code: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9.5 2.5l-3 11',
};

// ───────────────────────────────────────────────────────────── GitHub GraphQL ──

const API = 'https://api.github.com/graphql';
const rateLimit = { remaining: null, limit: null };

/** POST one GraphQL document; any HTTP or GraphQL error is fatal. */
async function gql(token, query, variables) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-stats-card',
    },
    body: JSON.stringify({ query, variables }),
  });
  rateLimit.remaining = res.headers.get('x-ratelimit-remaining') ?? rateLimit.remaining;
  rateLimit.limit = res.headers.get('x-ratelimit-limit') ?? rateLimit.limit;
  if (res.status !== 200) {
    throw new Error(`GraphQL HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  if (!body.data?.user) throw new Error(`GraphQL: no user in response for ${variables.login}`);
  return body.data;
}

// Public-only selection, trimmed to what the card renders. `name` and `gists` were removed:
// gists is a user-level resource the Actions GITHUB_TOKEN cannot read (Resource not accessible
// by integration), and neither value was ever drawn.
// the card stays anonymous by design.
const PROFILE_QUERY = `
query Profile($login: String!, $after: String) {
  user(login: $login) {
    createdAt
    followers { totalCount }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      contributionCalendar { totalContributions }
    }
    repositories(ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC, first: 100, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        stargazerCount
        forkCount
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

const YEAR_QUERY = `
query Year($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar { totalContributions }
    }
  }
}`;

/** Profile fields plus every public, non-fork, owned repository (paginated past 100). */
async function fetchProfile(token, login) {
  let user = null;
  const repos = [];
  let after = null;
  do {
    const data = await gql(token, PROFILE_QUERY, { login, after });
    user ??= data.user;
    const page = data.user.repositories;
    repos.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return { user, repos };
}

/**
 * All-time contributions: the API caps a contributionsCollection window at one year, so
 * query each calendar year from the account's creation year onward and sum them.
 */
async function fetchAllTimeContributions(token, login, createdAt) {
  const firstYear = new Date(createdAt).getUTCFullYear();
  const lastYear = new Date().getUTCFullYear();
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i);
  const totals = await Promise.all(
    years.map(async (year) => {
      const data = await gql(token, YEAR_QUERY, {
        login,
        from: `${year}-01-01T00:00:00Z`,
        to: `${year}-12-31T23:59:59Z`,
      });
      return data.user.contributionsCollection.contributionCalendar.totalContributions;
    }),
  );
  return { years, total: totals.reduce((sum, n) => sum + n, 0) };
}

// ───────────────────────────────────────────────────────────── aggregation ──

/** Reduce the raw API payload to the numbers the card shows. */
function summarize(user, repos, allTime) {
  const bytes = new Map();
  const colors = new Map();
  let stars = 0;
  let forks = 0;
  for (const repo of repos) {
    stars += repo.stargazerCount;
    forks += repo.forkCount;
    for (const { size, node } of repo.languages.edges) {
      bytes.set(node.name, (bytes.get(node.name) ?? 0) + size);
      if (node.color) colors.set(node.name, node.color);
    }
  }

  // Top languages by bytes; ties broken by name so the order is stable run to run.
  const top = [...bytes]
    .map(([name, size]) => ({ name, size, color: colors.get(name) ?? LANG_FALLBACK_COLOR }))
    .sort((a, b) => b.size - a.size || (a.name < b.name ? -1 : 1))
    .slice(0, TOP_LANGS);
  const topBytes = top.reduce((sum, l) => sum + l.size, 0);
  const langs = top.map((l) => ({ ...l, share: topBytes ? l.size / topBytes : 0 }));

  const cc = user.contributionsCollection;
  return {
    stars,
    forks,
    repos: user.repositories.totalCount,
    followers: user.followers.totalCount,
    sinceYear: allTime.years[0],
    contribYear: cc.contributionCalendar.totalContributions,
    commitsYear: cc.totalCommitContributions,
    prsYear: cc.totalPullRequestContributions,
    issuesYear: cc.totalIssueContributions,
    contribAllTime: allTime.total,
    langs,
  };
}

// ───────────────────────────────────────────────────────────── SVG rendering ──

const fmt = (n) => new Intl.NumberFormat('en-US').format(n);
const pct = (share) => `${(share * 100).toFixed(1)}%`;
const sec = (s) => `${s.toFixed(2)}s`;
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** Approximate advance widths (em) for a Helvetica-class sans — only used to decide truncation. */
const GLYPH_EM = {
  a: 0.53, b: 0.56, c: 0.5, d: 0.56, e: 0.53, f: 0.3, g: 0.56, h: 0.56, i: 0.22, j: 0.22, k: 0.5, l: 0.22, m: 0.83,
  n: 0.56, o: 0.56, p: 0.56, q: 0.56, r: 0.33, s: 0.5, t: 0.28, u: 0.56, v: 0.5, w: 0.72, x: 0.5, y: 0.5, z: 0.5,
  A: 0.67, B: 0.67, C: 0.72, D: 0.72, E: 0.67, F: 0.61, G: 0.78, H: 0.72, I: 0.28, J: 0.5, K: 0.67, L: 0.56, M: 0.83,
  N: 0.72, O: 0.78, P: 0.67, Q: 0.78, R: 0.72, S: 0.67, T: 0.61, U: 0.72, V: 0.67, W: 0.94, X: 0.67, Y: 0.67, Z: 0.61,
  ' ': 0.28, '.': 0.28, ',': 0.28, '-': 0.33, '+': 0.58, '#': 0.56, '%': 0.89, '/': 0.28, "'": 0.19, '…': 1,
};
const GLYPH_SAFETY = 1.04; // fallback faces (Segoe UI, Noto Sans) run a touch wider than Helvetica
function textWidth(str, px) {
  let em = 0;
  for (const ch of str) em += GLYPH_EM[ch] ?? (/[0-9]/.test(ch) ? 0.56 : 0.6);
  return em * px * GLYPH_SAFETY;
}
/** Truncate with an ellipsis until the estimated width fits. */
function fitText(str, px, maxWidth) {
  if (textWidth(str, px) <= maxWidth) return str;
  const chars = [...str];
  for (let n = chars.length - 1; n > 0; n--) {
    const candidate = `${chars.slice(0, n).join('').trimEnd()}…`;
    if (textWidth(candidate, px) <= maxWidth) return candidate;
  }
  return '…';
}

function icon(name, x, y) {
  return `<g class="icon" transform="translate(${x} ${y})"><path d="${ICONS[name]}"/></g>`;
}

function stylesheet(t) {
  const L = LAYOUT;
  return `
    .card { fill: ${t.bg}; stroke: ${t.border}; stroke-width: 1; }
    text { font-family: ${FONT_TEXT}; fill: ${t.text}; }
    .title { font-size: ${L.font.title}px; font-weight: 600; fill: ${t.title}; }
    .label { font-size: ${L.font.label}px; }
    .num { font-family: ${FONT_MONO}; font-size: ${L.font.num}px; font-weight: 600; fill: ${t.number}; }
    .section { font-size: ${L.font.section}px; font-weight: 600; }
    .legend { font-size: ${L.font.legend}px; }
    .pct { font-family: ${FONT_MONO}; font-size: ${L.font.pct}px; fill: ${t.muted}; }
    .empty { font-size: ${L.font.legend}px; fill: ${t.muted}; }
    .icon { fill: none; stroke: ${t.icon}; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
    .track { fill: ${t.barTrack}; }
    /* Rows start visible and the keyframes only add motion, so a renderer that ignores
       CSS animation (or shows a static frame) still displays the finished card. */
    .row { animation: rise ${sec(ANIM.rowDuration)} ease-out both; }
    .seg { transform-box: fill-box; transform-origin: left center;
           animation: grow ${sec(ANIM.barDuration)} cubic-bezier(.25, .8, .25, 1) both; }
    @keyframes rise { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
    @keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
    @media (prefers-reduced-motion: reduce) { .row, .seg { animation: none; } }
  `;
}

function renderCard(themeName, s) {
  const L = LAYOUT;
  const t = THEMES[themeName];
  const rowDelay = (i) => sec(ANIM.rowBase + ANIM.rowStagger * i);
  const rowBaseline = (i) => L.rowY + L.rowPitch * i;
  const iconTop = (baseline) => baseline - 12; // centres a 16px icon on 12px text

  const rows = [
    { icon: 'star', label: 'Total stars', value: s.stars },
    { icon: 'repo', label: 'Public repos', value: s.repos },
    { icon: 'commit', label: 'Contributions, last 12 months', value: s.contribYear },
    { icon: 'graph', label: 'Contributions, all-time', value: s.contribAllTime },
    { icon: 'people', label: 'Followers', value: s.followers },
  ];

  const parts = [];

  // Left column — stat rows.
  rows.forEach((r, i) => {
    const y = rowBaseline(i);
    parts.push(`  <g class="row" style="animation-delay:${rowDelay(i)}">
    ${icon(r.icon, L.padX, iconTop(y))}
    <text class="label" x="${L.labelX}" y="${y}">${esc(r.label)}</text>
    <text class="num" x="${L.numX}" y="${y}" text-anchor="end">${fmt(r.value)}</text>
  </g>`);
  });

  // Right column — header, stacked bar, legend.
  const headY = rowBaseline(0);
  parts.push(`  <g class="row" style="animation-delay:${rowDelay(0)}">
    ${icon('code', L.rightX, iconTop(headY))}
    <text class="section" x="${L.rightX + L.labelX - L.padX}" y="${headY}">Top languages</text>
  </g>`);

  parts.push(`  <rect class="track" x="${L.rightX}" y="${L.barY}" width="${L.rightW}" height="${L.barH}" rx="${L.barH / 2}"/>`);
  const segments = [];
  let cursor = 0;
  s.langs.forEach((lang, i) => {
    const last = i === s.langs.length - 1;
    const x = L.rightX + cursor;
    const w = lang.share * L.rightW;
    // The last segment runs to the bar's end; earlier ones overlap 0.5px to hide seams.
    const drawW = last ? L.rightX + L.rightW - x : w + 0.5;
    segments.push(`    <rect class="seg" x="${x.toFixed(2)}" y="${L.barY}" width="${drawW.toFixed(2)}" height="${L.barH}" fill="${esc(lang.color)}" style="animation-delay:${sec(ANIM.barBase + ANIM.barStagger * i)}"/>`);
    cursor += w;
  });
  if (segments.length) {
    parts.push(`  <g clip-path="url(#bar-clip)">\n${segments.join('\n')}\n  </g>`);
  }

  const colW = (L.rightW - L.legendGutter * (L.legendCols - 1)) / L.legendCols;
  const dotR = 3.5;
  const nameOffset = dotR * 2 + 4;
  if (!s.langs.length) {
    parts.push(`  <text class="empty row" x="${L.rightX}" y="${rowBaseline(2)}" style="animation-delay:${rowDelay(2)}">No public code yet</text>`);
  }
  s.langs.forEach((lang, i) => {
    const col = i % L.legendCols;
    const row = Math.floor(i / L.legendCols);
    const x = L.rightX + col * (colW + L.legendGutter);
    const y = rowBaseline(2 + row);
    const pctText = pct(lang.share);
    const pctW = pctText.length * 0.6 * L.font.pct; // monospace advance
    // "Name 12.3%" flows inline (GitHub's own legend convention) so the pairing is unambiguous;
    // the browser positions the percentage after the real glyphs via tspan dx.
    const name = fitText(lang.name, L.font.legend, colW - nameOffset - 4 - pctW);
    parts.push(`  <g class="row" style="animation-delay:${rowDelay(2 + row)}">
    <circle cx="${x + dotR}" cy="${y - dotR}" r="${dotR}" fill="${esc(lang.color)}"/>
    <text class="legend" x="${x + nameOffset}" y="${y}">${esc(name)}<tspan class="pct" dx="4">${pctText}</tspan></text>
  </g>`);
  });

  // Accessible plain-text summary — the same numbers the card shows.
  const langSummary = s.langs.length
    ? ` Top languages: ${s.langs.map((l) => `${l.name} ${pct(l.share)}`).join(', ')}.`
    : '';
  const title =
    `GitHub at a glance: ${fmt(s.stars)} stars, ${fmt(s.repos)} public repos, ` +
    `${fmt(s.contribYear)} contributions in the last 12 months, ${fmt(s.contribAllTime)} all-time, ` +
    `${fmt(s.followers)} followers.${langSummary}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}" role="img" aria-labelledby="card-title">
  <title id="card-title">${esc(title)}</title>
  <style>${stylesheet(t)}</style>
  <defs>
    <clipPath id="bar-clip"><rect x="${L.rightX}" y="${L.barY}" width="${L.rightW}" height="${L.barH}" rx="${L.barH / 2}"/></clipPath>
  </defs>
  <rect class="card" x="0.5" y="0.5" width="${L.width - 1}" height="${L.height - 1}" rx="${L.radius}"/>
  <text class="title" x="${L.padX}" y="${L.titleY}">GitHub at a glance</text>
${parts.join('\n')}
</svg>
`;
}

// ───────────────────────────────────────────────────────────── main ──

function summaryLine(login, s) {
  const langs = s.langs.map((l) => `${l.name} ${pct(l.share)}`).join(', ') || 'none';
  return (
    `${login}: stars=${s.stars} forks=${s.forks} repos=${s.repos} followers=${s.followers} ` +
    `contrib12m=${s.contribYear} (commits=${s.commitsYear} prs=${s.prsYear} issues=${s.issuesYear}) ` +
    `allTime=${s.contribAllTime} since=${s.sinceYear} langs=[${langs}]`
  );
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new Error(`Node >= 20 required (running ${process.versions.node})`);

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('set GH_TOKEN (or GITHUB_TOKEN)');
  const login = process.env.GH_USER || 'rezzminator';

  const { user, repos } = await fetchProfile(token, login);
  const allTime = await fetchAllTimeContributions(token, login, user.createdAt);
  const stats = summarize(user, repos, allTime);

  const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
  await mkdir(outDir, { recursive: true });
  for (const theme of Object.keys(THEMES)) {
    await writeFile(path.join(outDir, `stats-${theme}.svg`), renderCard(theme, stats));
  }

  console.log(summaryLine(login, stats));
  if (rateLimit.remaining !== null) {
    console.error(`graphql rate limit: ${rateLimit.remaining}/${rateLimit.limit} points remaining`);
  }
}

main().catch((err) => {
  console.error(`stats: ${err.message}`);
  process.exit(1);
});
