import { $ } from 'bun';

const TARGETS = [
  { bunTarget: 'bun-darwin-arm64', name: 'darwin-arm64' },
  { bunTarget: 'bun-darwin-x64', name: 'darwin-x64' },
  { bunTarget: 'bun-linux-x64', name: 'linux-x64' },
  { bunTarget: 'bun-linux-arm64', name: 'linux-arm64' },
] as const;

const ENTRY = 'src/cli.ts';
const OUT_DIR = 'dist';

await $`mkdir -p ${OUT_DIR}`;

for (const target of TARGETS) {
  const outFile = `${OUT_DIR}/claude-telemetry-${target.name}`;
  console.log(`Building ${target.name}...`);
  await $`bun build ${ENTRY} --compile --target ${target.bunTarget} --outfile ${outFile}`;
  const stat = await $`wc -c < ${outFile}`.text();
  const sizeKb = Math.round(Number.parseInt(stat.trim(), 10) / 1024);
  console.log(`  ✓ ${outFile} (${sizeKb} KB)`);
}

console.log('\nAll targets built successfully.');
