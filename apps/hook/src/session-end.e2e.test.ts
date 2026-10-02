import { Database } from 'bun:sqlite';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  aiot,
  buildBinary,
  hookPayload,
  type Machine,
  makeMachine,
  makeRepo,
  newSessionId,
  SKIP_E2E,
  until,
  writeTranscript,
} from './lib/e2e-harness';

// A SessionEnd on a big COLD transcript, as real processes against the compiled
// binary. What it must never do: hold the queue's write lock long enough to make a
// concurrent hook of another session fail (the busy timeout is 100 ms), or leave a
// killed hook without its SessionEnd row and ship marker.

const maybe = SKIP_E2E ? describe.skip : describe;
const TURNS = 10_000;
// Tool hooks of OTHER sessions arrive, one every 10 ms, for as long as the SessionEnd runs.
// (Dozens in the same few ms starve the machine itself: a control run with a one-turn
// transcript loses events at that rate too, and so does any run on a loaded box.)
const MAX_TOOL_HOOKS = 150;
const TOOL_GAP_MS = 10;

beforeAll(() => {
  if (!SKIP_E2E) {
    buildBinary();
  }
}, 180_000);

const procs: Array<{ kill(sig?: number | NodeJS.Signals): void }> = [];
afterEach(() => {
  for (const p of procs.splice(0)) {
    try {
      p.kill('SIGKILL');
    } catch {
      // gone
    }
  }
});

type Setup = { m: Machine; sessionId: string; transcript: string; cwd: string };

function setup(turns = TURNS): Setup {
  const m = makeMachine();
  const sessionId = newSessionId();
  const cwd = makeRepo(m);
  const transcript = join(m.home, '.claude', 'projects', 'widgets', `${sessionId}.jsonl`);
  writeTranscript(transcript, sessionId, cwd, turns);
  return { cwd, m, sessionId, transcript };
}

function spawnHook(s: Setup, kind: string, stdin: string) {
  const p = Bun.spawn([s.m.aiot, 'hook', kind], {
    env: s.m.env,
    stderr: 'ignore',
    stdin: Buffer.from(stdin),
    stdout: 'ignore',
  });
  procs.push(p);
  return p;
}

const sessionEndPayload = (s: Setup) => hookPayload('SessionEnd', s.sessionId, s.transcript, s.cwd);

/** Rerun the SessionEnd until its cursor reaches the end: each run has a ~0.7 s budget. */
async function finish(s: Setup, turns = TURNS): Promise<void> {
  for (let run = 0; run < 10 && cursor(s)?.turns !== turns; run++) {
    const r = await aiot(s.m, ['hook', 'session-end'], { stdin: sessionEndPayload(s) });
    expect(r.code).toBe(0);
  }
  expect(cursor(s)?.turns).toBe(turns);
}

const count = (m: Machine, where: string): number => {
  try {
    return m.db(
      (db) =>
        (db.query(`SELECT count(*) AS c FROM events_queue WHERE ${where}`).get() as { c: number })
          .c,
    );
  } catch {
    return 0; // queue.db not created yet
  }
};
const eventType = (t: string) => `json_extract(payload_json, '$.event_type') = '${t}'`;
const marker = (s: Setup) => join(s.m.aiotHome, 'ship-queue', `${s.sessionId}.json`);
const cursor = (s: Setup) => {
  const p = join(s.m.aiotHome, 'agent-state', 'claude-code', `${s.sessionId}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { turns: number }) : null;
};
const logLines = (m: Machine, needle: string): number => {
  try {
    return readFileSync(join(m.aiotHome, 'hook.log'), 'utf8')
      .split('\n')
      .filter((l) => l.includes(needle)).length;
  } catch {
    return 0;
  }
};

maybe('SessionEnd with a large cold transcript, compiled binary', () => {
  /** One SessionEnd on a cold transcript with tool hooks of other sessions arriving throughout. */
  async function scenario() {
    const s = setup();
    const other = (i: number) =>
      JSON.stringify({
        cwd: '/home/dev/other',
        hook_event_name: 'PreToolUse',
        session_id: newSessionId(),
        tool_input: { command: `ls ${i}` },
        tool_name: 'Bash',
        tool_use_id: `toolu_01A09q90qw90lq9${String(i).padStart(6, '0')}`,
      });
    const end = spawnHook(s, 'session-end', sessionEndPayload(s));
    const tools: Array<ReturnType<typeof spawnHook>> = [];
    await until(() => count(s.m, eventType('SessionEnd')) === 1, 20_000, 'SessionEnd queued');
    let ended = false;
    end.exited.then(() => {
      ended = true;
    });
    for (let i = 0; !ended && i < MAX_TOOL_HOOKS; i++) {
      tools.push(spawnHook(s, 'pre-tool-use', other(i)));
      await Bun.sleep(TOOL_GAP_MS);
    }
    await Promise.all([end.exited, ...tools.map((t) => t.exited)]);
    return { lost: tools.length - count(s.m, eventType('PreToolUse')), s, tools: tools.length };
  }

  it('does not make concurrent hooks of other sessions fail, and the turns all arrive', async () => {
    // A box that is busy with other work can starve ANY writer past its 100 ms busy
    // timeout (a control run with a one-turn transcript loses events too), so a run
    // that loses one is repeated once. Holding the lock for a whole 10,000-row
    // transaction loses events in EVERY run (mutation: 8 of 8), so this still fails it.
    let run = await scenario();
    if (run.lost > 0) {
      run = await scenario();
    }
    const { s } = run;
    expect(run.tools).toBeGreaterThan(10); // the tool hooks really overlapped the tail
    expect(run.lost).toBe(0); // none dropped for a locked database
    expect(logLines(s.m, 'enqueue_failed')).toBe(0);
    // The tail yields to the tool hooks rather than failing them; whatever it did not get
    // to stays behind its cursor, and the next SessionEnd/Stop/import reads the rest.
    expect(cursor(s)?.turns ?? 0).toBeLessThanOrEqual(count(s.m, eventType('Stop')));
    await finish(s);
    expect(count(s.m, eventType('Stop'))).toBe(TURNS);
  }, 180_000);

  it('two SessionEnds at once count every turn once', async () => {
    const s = setup(2_000);
    const pair = [
      spawnHook(s, 'session-end', sessionEndPayload(s)),
      spawnHook(s, 'session-end', sessionEndPayload(s)),
    ];
    await Promise.all(pair.map((p) => p.exited));
    await finish(s, 2_000);
    expect(
      count(s.m, `${eventType('Stop')} AND json_extract(payload_json, '$.llm') IS NOT NULL`),
    ).toBe(2_000);
    const ids = s.m.db(
      (db) =>
        (
          db
            .query(
              "SELECT count(DISTINCT event_id) AS c FROM events_queue WHERE json_extract(payload_json, '$.llm') IS NOT NULL",
            )
            .get() as { c: number }
        ).c,
    );
    expect(ids).toBe(2_000);
  }, 120_000);

  it('another process holding the write lock for 400 ms mid-tail does not push the hook past its kill', async () => {
    // The tail's own pause is a multiple of how long a chunk took, and a chunk that waited
    // for someone else's lock took 400 ms: an uncapped 3x pause slept past 1.5 s, after the
    // marker but before the drainer spawn. The pause is capped (20 ms, and at the deadline).
    const s = setup();
    const t0 = performance.now();
    const p = spawnHook(s, 'session-end', sessionEndPayload(s));
    await until(
      () => count(s.m, eventType('SessionEnd')) === 1 && existsSync(marker(s)),
      20_000,
      'SessionEnd row and marker',
    );
    await Bun.sleep(Math.max(0, 150 - (performance.now() - t0)));
    const holder = new Database(join(s.m.aiotHome, 'queue.db'));
    try {
      holder.exec('PRAGMA busy_timeout = 5000');
      holder.exec('BEGIN IMMEDIATE');
      await Bun.sleep(400);
      holder.exec('COMMIT');
    } finally {
      holder.close();
    }
    await p.exited;
    const elapsed = performance.now() - t0;

    expect(count(s.m, eventType('SessionEnd'))).toBe(1);
    expect(existsSync(marker(s))).toBe(true);
    // The tail's 700 ms budget plus start-up and a final pause, comfortably inside 1.5 s.
    expect(elapsed).toBeLessThan(1_300);
  }, 60_000);

  // Claude Code kills a SessionEnd hook at its deadline (1.5 s by default). Killed 150 ms
  // and 250 ms after it started, with ~5,000 rows of a cold transcript still to go, the
  // hook must already have left its SessionEnd row and its ship marker.
  for (const killAtMs of [150, 250]) {
    it(`a hook killed ${killAtMs} ms in leaves the SessionEnd row and the marker; reruns finish with no duplicates`, async () => {
      const attempt = async () => {
        const s = setup();
        const p = spawnHook(s, 'session-end', sessionEndPayload(s));
        await Bun.sleep(killAtMs);
        p.kill('SIGKILL');
        await p.exited;
        return {
          marker: existsSync(marker(s)),
          s,
          sessionEnd: count(s.m, eventType('SessionEnd')),
        };
      };
      // A busy box can delay the process start past the kill; try once more before judging.
      let run = await attempt();
      if (run.sessionEnd !== 1 || !run.marker) {
        run = await attempt();
      }
      const { s } = run;
      expect(run.sessionEnd).toBe(1);
      expect(run.marker).toBe(true);
      // The cursor never runs ahead of what is queued.
      expect(cursor(s)?.turns ?? 0).toBeLessThanOrEqual(count(s.m, eventType('Stop')));

      await finish(s);
      expect(count(s.m, eventType('Stop'))).toBe(TURNS); // the rest, no duplicates
    }, 180_000);
  }
});
