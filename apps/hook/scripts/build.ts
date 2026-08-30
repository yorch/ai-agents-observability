import { $ } from 'bun';

const ENTRY = 'src/cli.ts';
const OUT_DIR = 'dist';
const LAUNCHER_DIR = 'launcher';

await $`mkdir -p ${OUT_DIR}`;

// Detect the current platform's target triple.
const isAll = process.argv.includes('--all');
const targets = isAll
  ? [
      { bunTarget: 'bun-darwin-arm64', name: 'darwin-arm64', rustTarget: 'aarch64-apple-darwin' },
      { bunTarget: 'bun-darwin-x64', name: 'darwin-x64', rustTarget: 'x86_64-apple-darwin' },
      { bunTarget: 'bun-linux-x64', name: 'linux-x64', rustTarget: 'x86_64-unknown-linux-gnu' },
      {
        bunTarget: 'bun-linux-arm64',
        name: 'linux-arm64',
        rustTarget: 'aarch64-unknown-linux-gnu',
      },
    ]
  : [detectCurrentTarget()];

for (const target of targets) {
  const runtimeFile = `${OUT_DIR}/aiot-runtime-${target.name}`;
  const launcherFile = `${OUT_DIR}/aiot-${target.name}`;

  console.log(`Building ${target.name}...`);

  // 1. Build the Bun-compiled runtime (50–80 MB).
  await $`bun build ${ENTRY} --compile --target ${target.bunTarget} --outfile ${runtimeFile}`;

  // 2. Build the Rust launcher (~100 KB).
  if (isAll) {
    await $`cargo build --release --manifest-path ${LAUNCHER_DIR}/Cargo.toml --target ${target.rustTarget}`;
    const releaseDir = `${LAUNCHER_DIR}/target/${target.rustTarget}/release`;
    await $`cp ${releaseDir}/aiot ${launcherFile}`;
  } else {
    // Native build — no --target flag needed, uses the host triple.
    await $`cargo build --release --manifest-path ${LAUNCHER_DIR}/Cargo.toml`;
    await $`cp ${LAUNCHER_DIR}/target/release/aiot ${launcherFile}`;
  }

  const runtimeStat = await $`wc -c < ${runtimeFile}`.text();
  const launcherStat = await $`wc -c < ${launcherFile}`.text();
  const runtimeKb = Math.round(Number.parseInt(runtimeStat.trim(), 10) / 1024);
  const launcherKb = Math.round(Number.parseInt(launcherStat.trim(), 10) / 1024);
  console.log(`  ✓ ${runtimeFile} (${runtimeKb} KB)`);
  console.log(`  ✓ ${launcherFile} (${launcherKb} KB)`);
}

console.log('\nBuild complete.');
console.log('Each target produces two binaries:');
console.log('  aiot-<target>         — Rust launcher (installed as /usr/local/bin/aiot)');
console.log('  aiot-runtime-<target> — Bun runtime  (installed as /usr/local/bin/aiot-runtime)');

function detectCurrentTarget(): { bunTarget: string; name: string; rustTarget: string } {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      bunTarget: 'bun-darwin-arm64',
      name: 'darwin-arm64',
      rustTarget: 'aarch64-apple-darwin',
    };
  }
  if (platform === 'darwin' && arch === 'x64') {
    return { bunTarget: 'bun-darwin-x64', name: 'darwin-x64', rustTarget: 'x86_64-apple-darwin' };
  }
  if (platform === 'linux' && arch === 'x64') {
    return {
      bunTarget: 'bun-linux-x64',
      name: 'linux-x64',
      rustTarget: 'x86_64-unknown-linux-gnu',
    };
  }
  if (platform === 'linux' && arch === 'arm64') {
    return {
      bunTarget: 'bun-linux-arm64',
      name: 'linux-arm64',
      rustTarget: 'aarch64-unknown-linux-gnu',
    };
  }
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}
