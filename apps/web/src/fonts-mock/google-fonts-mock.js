/**
 * Mocked Google Fonts CSS responses for offline/CI builds.
 *
 * Set via NEXT_FONT_GOOGLE_MOCKED_RESPONSES env var in the build script.
 * next/font/google checks this env var and uses these CSS responses instead
 * of fetching from fonts.googleapis.com — required in network-restricted CI.
 *
 * Font file URLs must end in .woff/.woff2/.eot/.ttf/.otf so that next/font
 * can extract the extension. When NEXT_FONT_GOOGLE_MOCKED_RESPONSES is set,
 * next/font returns Buffer.from(url) as the font binary (a harmless stub).
 */

// Stub URL pattern: next/font uses the URL to infer the file extension only.
// The actual bytes returned are Buffer.from(url) — a string, not a real font.
// That's fine for CI builds where we only need compilation to succeed.
const STUB = 'https://fonts.gstatic.com/s/stub/v1/mock.woff2';

function face(family, weight) {
  return (
    '/* latin */\n' +
    '@font-face {\n' +
    "  font-family: '" +
    family +
    "';\n" +
    '  font-style: normal;\n' +
    '  font-weight: ' +
    weight +
    ';\n' +
    '  font-display: swap;\n' +
    '  src: url(' +
    STUB +
    ") format('woff2');\n" +
    '  unicode-range: U+0000-00FF;\n' +
    '}\n'
  );
}

var dmSansCSS = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
  .map(function (w) {
    return face('DM Sans', w);
  })
  .join('\n');

var ibmPlexMonoCSS = [400, 500, 600]
  .map(function (w) {
    return face('IBM Plex Mono', w);
  })
  .join('\n');

var syneCSS = [400, 500, 600, 700, 800]
  .map(function (w) {
    return face('Syne', w);
  })
  .join('\n');

module.exports = {
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@100..1000&display=swap': dmSansCSS,
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap':
    ibmPlexMonoCSS,
  'https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&display=swap': syneCSS,
};
