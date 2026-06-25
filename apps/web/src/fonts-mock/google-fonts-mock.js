/**
 * Mocked Google Fonts CSS responses for offline/CI builds.
 * Set NEXT_FONT_GOOGLE_MOCKED_RESPONSES to the path of this file.
 * When this env var is set, next/font/google uses these responses instead of
 * hitting fonts.googleapis.com — required in egress-restricted environments.
 *
 * The font file URLs in src: url(...) are returned as-is as a Buffer when mocked,
 * so any non-empty string works.
 */

// Helper to generate a minimal @font-face block
function face(family, weight, url) {
  return `/* latin */\n@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: ${weight};\n  font-display: swap;\n  src: url(${url}) format('woff2');\n  unicode-range: U+0000-00FF;\n}\n`;
}

const dmSansUrl = 'https://fonts.gstatic.com/s/dmsans/v15/mock.woff2';
const ibmPlexMonoUrl = 'https://fonts.gstatic.com/s/ibmplexmono/v19/mock.woff2';
const syneUrl = 'https://fonts.gstatic.com/s/syne/v22/mock.woff2';

// DM Sans: variable weight 100..1000
// URL pattern: https://fonts.googleapis.com/css2?family=DM+Sans:wght@100..1000&display=swap
const dmSansCSS = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
  .map((w) => face('DM Sans', w, dmSansUrl))
  .join('\n');

// IBM Plex Mono: weights 400, 500, 600
// URL pattern: https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap
const ibmPlexMonoCSS = [400, 500, 600]
  .map((w) => face('IBM Plex Mono', w, ibmPlexMonoUrl))
  .join('\n');

// Syne: weights 400, 500, 600, 700, 800
// URL pattern: https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&display=swap
const syneCSS = [400, 500, 600, 700, 800].map((w) => face('Syne', w, syneUrl)).join('\n');

module.exports = {
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@100..1000&display=swap': dmSansCSS,
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap':
    ibmPlexMonoCSS,
  'https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&display=swap': syneCSS,
};
