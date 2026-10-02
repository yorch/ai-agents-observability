import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  aiot,
  buildBinary,
  type FakeIngest,
  ghCalls,
  HOOK_KIND,
  hookPayload,
  type Machine,
  makeMachine,
  makeRepo,
  newSessionId,
  SKIP_E2E,
  startIngest,
  until,
  writeTranscript,
} from './lib/e2e-harness';

// End-to-end tests of the daemonless mode. Every one of them drives the COMPILED
// binary as real processes against a fake ingest server: a hook is a child, the
// drainer is whatever that hook spawned, and what is asserted is what the server
// actually received. Nothing here calls the drain code in-process, because that
// is how a "spawn" test passes while spawning nothing (process.execPath is `bun`
// under `bun test`, and `bun drain` is a no-op).
//
// No test here resets `spawn_claimed_until` or runs an explicit `aiot drain` to
// stand in for a hook that should have spawned one: an earlier version did, and it
// hid a drainer that ignored every hook arriving within 10 s of the last spawn.

const maybe = SKIP_E2E ? describe.skip : describe;

let machine: Machine;
let ingest: FakeIngest | null = null;
const extraIngests: FakeIngest[] = [];
const children: Array<{ kill(sig?: number | NodeJS.Signals): void }> = [];

beforeAll(() => {
  if (!SKIP_E2E) {
    buildBinary();
  }
}, 180_000);

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      c.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  ingest?.stop();
  for (const i of extraIngests.splice(0)) {
    i.stop();
  }
  ingest = null;
});

async function onDemandMachine(opts: Parameters<typeof startIngest>[0] = {}) {
  machine = makeMachine();
  ingest = startIngest(opts);
  machine.setIngest(ingest.url);
  machine.login();
  const r = await aiot(machine, ['install', '--mode', 'on-demand', '--no-auto']);
  expect(r.stderr).toBe('');
  expect(r.code).toBe(0);
  return { ingest, machine };
}

/** A machine in the default resident mode with no daemons: hooks only enqueue. */
function residentMachine(opts: Parameters<typeof startIngest>[0] = {}) {
  machine = makeMachine();
  ingest = startIngest(opts);
  machine.setIngest(ingest.url);
  machine.login();
  return { ingest, machine };
}

type Session = { id: string; transcript: string; cwd: string };

function session(m: Machine, turns = 2, padKb = 0): Session {
  const id = newSessionId();
  const cwd = makeRepo(m);
  const transcript = join(m.home, '.claude', 'projects', 'widgets', `${id}.jsonl`);
  writeTranscript(transcript, id, cwd, turns, padKb);
  return { cwd, id, transcript };
}

async function hook(
  m: Machine,
  kind: keyof typeof HOOK_KIND,
  s: Session,
  env: Record<string, string> = {},
) {
  const r = await aiot(m, ['hook', HOOK_KIND[kind]], {
    env,
    stdin: hookPayload(kind, s.id, s.transcript, s.cwd),
  });
  expect(r.code).toBe(0);
  return r;
}

/** Drainer processes that have finished a pass (each logs one `drain.done`, even a busy one). */
const drainsFinished = (m: Machine) => {
  try {
    return readFileSync(join(m.aiotHome, 'hook.log'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"drain.done"')).length;
  } catch {
    return 0;
  }
};

/**
 * Run a hook and wait for the drainer IT spawned to finish. Used for sequences of
 * hooks that are each separated by a finished drain; a test about hooks that land
 * while a drainer is still running does not use it.
 */
async function hookAndSettle(m: Machine, kind: keyof typeof HOOK_KIND, s: Session) {
  const before = drainsFinished(m);
  await hook(m, kind, s);
  await until(() => drainsFinished(m) > before, 30_000, 'the spawned drainer to finish');
}

const logHas = (m: Machine, text: string): boolean => {
  try {
    return readFileSync(join(m.aiotHome, 'hook.log'), 'utf8').includes(text);
  } catch {
    return false;
  }
};

type Holder = { pid: number; role: string } | null;
const holderOf = (m: Machine): Holder =>
  m.db(
    (db) =>
      db
        .query(
          'SELECT pid, role FROM delivery_lease WHERE pid IS NOT NULL AND expires_at > ? ORDER BY started_at DESC LIMIT 1',
        )
        .get(Date.now()) as Holder,
  );

const pidGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

const spawnClaimed = (m: Machine) =>
  m.db(
    (db) => (db.query('SELECT spawn_claimed_until AS c FROM drain_state').get() as { c: number }).c,
  );
const queueDepth = (m: Machine) =>
  m.db((db) => (db.query('SELECT COUNT(*) AS c FROM events_queue').get() as { c: number }).c);
const modeOf = (m: Machine) =>
  m.db((db) => (db.query('SELECT mode FROM drain_state').get() as { mode: string }).mode);
const completed = (i: FakeIngest, s: Session) => i.transcripts.get(s.id)?.completed ?? 0;

maybe('on-demand mode, compiled binary', () => {
  it('a Stop hook spawns a drainer that delivers events, then the transcript', async () => {
    const { ingest, machine: m } = await onDemandMachine();
    const s = session(m);

    await hook(m, 'Stop', s);

    await until(() => completed(ingest, s) === 1, 20_000, 'transcript');
    expect(ingest.events.length).toBeGreaterThan(0);
    expect(ingest.events.every((e) => e.session_id === s.id)).toBe(true);
    // Events strictly before the transcript: the fake 404s the transcript route
    // until the session row exists, so a drainer that shipped in the wrong order
    // would never have completed an upload.
    expect(ingest.violations).toEqual([]);
    await until(() => queueDepth(m) === 0, 5_000, 'queue empty');
    const lastOk = m.db(
      (db) =>
        (db.query('SELECT last_drain_ok_at AS t FROM drain_state').get() as { t: number | null }).t,
    );
    expect(lastOk).not.toBeNull();
  }, 60_000);

  // The commonest ending of a session: the last answer, then `/exit` seconds later.
  // The Stop's drainer is still inside (or just past) its pass when SessionEnd fires.
  describe('hooks that land while, or just after, a drainer runs are not stranded', () => {
    it('a SessionEnd 2 s after a finished drain is delivered with no manual drain and no claim reset', async () => {
      const { ingest, machine: m } = await onDemandMachine();
      const s = session(m, 3);

      await hookAndSettle(m, 'Stop', s);
      expect(completed(ingest, s)).toBe(1);
      const eventsBefore = ingest.events.length;

      await Bun.sleep(2_000);
      await hook(m, 'SessionEnd', s);

      // The final event and the final transcript, both by a drainer the SessionEnd
      // hook itself started — inside what used to be a 10 s dead zone.
      await until(() => ingest.events.length > eventsBefore, 20_000, 'the SessionEnd event');
      await until(() => completed(ingest, s) === 2, 20_000, 'the final transcript');
      expect(queueDepth(m)).toBe(0);
      expect(ingest.violations).toEqual([]);
    }, 90_000);

    it('a Stop that lands WHILE the drainer is shipping transcripts is picked up by that drainer', async () => {
      // Slow chunks keep the drainer inside the transcript upload for seconds.
      const { ingest, machine: m } = await onDemandMachine({ chunkDelayMs: 900 });
      const s = session(m, 2, 1200);

      await hook(m, 'Stop', s);
      await until(
        () => ingest.transcripts.get(s.id)?.assembling === true,
        30_000,
        'the drainer mid-upload',
      );
      const holder = holderOf(m);
      expect(holder?.role).toBe('drain');

      // The agent finishes another turn and exits while that upload is in flight.
      // A held lease means this hook spawns nothing: the running drainer must look
      // again before it lets go.
      await hook(m, 'Stop', s);
      await hook(m, 'SessionEnd', s);

      await until(() => queueDepth(m) === 0, 60_000, 'every event delivered');
      await until(() => ingest.events.some((e) => e.event_type === 'SessionEnd'), 20_000, 'end');
      // The first upload was superseded by the later hooks, so a second one carries
      // the final transcript.
      await until(() => completed(ingest, s) >= 2, 60_000, 'the transcript after the SessionEnd');
      expect(ingest.violations).toEqual([]);
      // And it was ONE drainer process throughout, not a second one racing it.
      expect(drainsFinished(m)).toBe(1);
    }, 150_000);
  });

  // A resident shipper or an `aiot import` holds the TRANSCRIPTS lease for seconds to
  // minutes. A drainer spawned meanwhile must still deliver the events: it used to
  // refuse whenever ANY lease was held, and nothing ever came back for the hooks
  // that fired in that time (the probe: an 8 s import, Stop + SessionEnd, 15 s after
  // release — nothing delivered, four rows still queued).
  describe('hooks that fire while something else holds the transcripts lease', () => {
    const FIXTURE = join(import.meta.dir, 'lib', 'lease-holder.fixture.ts');

    it('are delivered during the hold, without any manual drain', async () => {
      const { ingest, machine: m } = await onDemandMachine();
      const s = session(m, 3);
      const holder = Bun.spawn(['bun', FIXTURE, join(m.aiotHome, 'queue.db'), 'import', '9000'], {
        stderr: 'inherit',
        stdout: 'pipe',
      });
      children.push(holder);
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toStartWith('HELD');
      reader.releaseLock();
      const heldUntil = Date.now() + 8_000;

      await hook(m, 'Stop', s);
      await hook(m, 'SessionEnd', s);

      await until(() => queueDepth(m) === 0, 6_000, 'the events, while the import still holds');
      expect(Date.now()).toBeLessThan(heldUntil); // i.e. it did NOT wait for the release
      expect(ingest.events.some((e) => e.event_type === 'SessionEnd')).toBe(true);
      // The transcript is the holder's to ship; the drainer left it alone.
      expect(completed(ingest, s)).toBe(0);
    }, 60_000);

    it('and a real `aiot import` ships the leftovers itself when it finishes', async () => {
      // The import's transcript upload is slow, so it is still holding the transcripts
      // lease long after the hooks' drainer has delivered their events and gone.
      const { ingest, machine: m } = await onDemandMachine({
        eventsDelayMs: 300,
        unchunkedDelayMs: 7_000,
      });
      const s = session(m, 3);
      const imp = Bun.spawn([m.aiot, 'import', '--quiet'], {
        env: { ...m.env, CLAUDE_PROJECTS_DIR: join(m.home, '.claude', 'projects') },
        stderr: 'ignore',
        stdout: 'ignore',
      });
      children.push(imp);
      await until(() => holderOf(m)?.role === 'import', 15_000, 'the import to hold its lease');

      await hook(m, 'Stop', s);
      await hook(m, 'SessionEnd', s);
      // The hooks' drainer delivers the events and, unable to take the transcripts, leaves.
      await until(() => drainsFinished(m) >= 1, 20_000, 'the hooks’ drainer to finish');
      expect(holderOf(m)?.role).toBe('import');
      expect(imp.exitCode).toBeNull();
      await imp.exited;

      // No manual drain: the SessionEnd's marker is final and dirty, and the import's
      // own post-pass is what ships it (the hook's drainer could not touch it).
      await until(() => queueDepth(m) === 0, 30_000, 'every event delivered');
      await until(
        () => completed(ingest, s) >= 2,
        30_000,
        "the import's and then the final upload",
      );
      expect(ingest.violations).toEqual([]);
    }, 120_000);
  });

  // (c) The agent may kill the hook's process group the instant the hook returns.
  // The drainer has to be in a different session to survive it.
  it('the drainer survives the agent killing the hook process group, and is fully detached', async () => {
    const { ingest, machine: m } = await onDemandMachine({ eventsDelayMs: 2000 });
    const s = session(m);
    const payloadFile = join(m.home, 'payload.json');
    writeFileSync(payloadFile, hookPayload('Stop', s.id, s.transcript, s.cwd));

    // The "agent": a process-group leader that runs the hook, then lingers.
    const agent = Bun.spawn(['sh', '-c', `"${m.aiot}" hook stop < "${payloadFile}"; sleep 120`], {
      detached: true,
      env: {
        ...m.env,
        // Things an agent's shell routinely carries. The first two redirect
        // delivery and must never reach the drainer; the others are the user's
        // GitHub identity, which enrichment needs and which therefore DO.
        AIOT_QUEUE_MAX_EVENTS: '1',
        GH_HOST: 'github.example.com',
        // Names the host a token is sent to: never from the agent's shell.
        GITHUB_API_URL: 'https://attacker.example/api/v3',
        GITHUB_TOKEN: 'ghp_from_the_agent_shell',
        INGEST_BASE_URL: 'http://127.0.0.1:1',
        OPENAI_API_KEY: 'sk-not-ours',
      },
      stderr: 'ignore',
      stdin: 'ignore',
      stdout: 'ignore',
    });
    children.push({ kill: (sig) => process.kill(-agent.pid, sig as NodeJS.Signals) });

    // The drainer has taken its first batch and is inside the (slow) POST.
    await until(() => ingest.eventRequests >= 1, 20_000, 'drainer POST in flight');
    const holder = holderOf(m);
    expect(holder?.role).toBe('drain');

    // ── Empirical: what is this process? (Linux only; recorded in the PR notes.)
    if (process.platform === 'linux' && holder) {
      const pid = holder.pid;
      const fd = (n: number) => readlinkSync(`/proc/${pid}/fd/${n}`);
      const statOf = (p: number) => {
        const stat = readFileSync(`/proc/${p}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      };
      const pgrp = Number(statOf(pid)[2]);
      const sid = Number(statOf(pid)[3]);
      const agentSid = Number(statOf(agent.pid)[3]);
      const environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);
      const envNames = environ.map((e) => e.split('=')[0]);
      console.log(
        `[empirical] drainer pid=${pid} pgid=${pgrp} sid=${sid} agentSid=${agentSid} ` +
          `fd0=${fd(0)} fd1=${fd(1)} fd2=${fd(2)} cwd=${readlinkSync(`/proc/${pid}/cwd`)} ` +
          `env=[${envNames.join(',')}]`,
      );
      // Own session and process group: a killpg on the agent's group cannot reach it.
      expect(sid).toBe(pid);
      expect(pgrp).toBe(pid);
      expect(sid).not.toBe(agentSid);
      // Nothing inherited from the hook: all three stdio fds are /dev/null.
      expect([fd(0), fd(1), fd(2)]).toEqual(['/dev/null', '/dev/null', '/dev/null']);
      // Never pins the agent's worktree.
      expect(readlinkSync(`/proc/${pid}/cwd`)).toBe(realpathSync(m.aiotHome));
      // What redirects delivery, and unrelated secrets, never arrive...
      expect(envNames).not.toContain('INGEST_BASE_URL');
      expect(envNames).not.toContain('AIOT_QUEUE_MAX_EVENTS');
      expect(envNames).not.toContain('OPENAI_API_KEY');
      expect(envNames).not.toContain('GITHUB_API_URL');
      // ...the user's GitHub auth does (only when set: GH_CONFIG_DIR was not).
      expect(environ).toContain('GITHUB_TOKEN=ghp_from_the_agent_shell');
      expect(environ).toContain('GH_HOST=github.example.com');
      expect(envNames).not.toContain('GH_CONFIG_DIR');
      expect(environ).toContain(`AIOT_HOME=${m.aiotHome}`);
    }

    // Now the agent kills the hook's whole process group.
    process.kill(-agent.pid, 'SIGKILL');
    await agent.exited;
    expect(agent.signalCode).toBe('SIGKILL');

    // The drainer was mid-POST when that happened. It can only reach the
    // transcript route — which needs its events POST to have returned and been
    // processed — if it lived through the kill.
    await until(() => completed(ingest, s) === 1, 30_000, 'transcript');
    expect(ingest.events.length).toBeGreaterThan(0);
  }, 90_000);

  // (e) The drainer's configuration comes from the config file, not the agent's shell.
  it('ignores INGEST_BASE_URL in the agent shell', async () => {
    const { ingest, machine: m } = await onDemandMachine();
    const decoy = startIngest();
    extraIngests.push(decoy);
    const s = session(m);

    await hook(m, 'Stop', s, { INGEST_BASE_URL: decoy.url });

    await until(() => completed(ingest, s) === 1, 20_000, 'transcript');
    expect(ingest.events.length).toBeGreaterThan(0);
    expect(decoy.eventRequests).toBe(0);
    expect(decoy.transcripts.size).toBe(0);
  }, 60_000);

  describe('spawn rules', () => {
    it('never spawns from a tool-lifecycle hook, nor while paused, nor in resident mode', async () => {
      const { ingest, machine: m } = await onDemandMachine();
      const s = session(m);

      await hook(m, 'PreToolUse', s);
      expect(spawnClaimed(m)).toBe(0);

      writeFileSync(join(m.aiotHome, 'paused'), '');
      await hook(m, 'Stop', s);
      expect(spawnClaimed(m)).toBe(0);
      await aiot(m, ['resume']);

      await aiot(m, ['install', '--mode', 'resident', '--no-start', '--no-auto', '--force']);
      await hook(m, 'Stop', s);
      expect(spawnClaimed(m)).toBe(0);

      await Bun.sleep(1000);
      expect(ingest.eventRequests).toBe(0);
    }, 60_000);

    it('SessionStart spawns a catch-up drainer even with nothing new to enqueue', async () => {
      const env = await onDemandMachine();
      const m = env.machine;
      const s = session(m);

      // Leave undelivered data from an earlier session: server down at the time.
      env.ingest.stop();
      m.setIngest('http://127.0.0.1:1');
      await hook(m, 'Stop', s);
      await until(() => drainsFinished(m) >= 1, 20_000, 'first drainer to finish');
      expect(queueDepth(m)).toBeGreaterThan(0);

      // Next day: server is back; a new session starts. The failed pass put a 30 s
      // floor on spawning and a retry time on the rows; "next day" is longer than both.
      await Bun.sleep(31_000);
      const back = startIngest();
      extraIngests.push(back);
      m.setIngest(back.url);
      const s2 = session(m);
      await hook(m, 'SessionStart', s2);

      await until(() => back.events.some((e) => e.session_id === s.id), 20_000, 'old events');
      await until(() => queueDepth(m) === 0, 10_000, 'queue empty');
    }, 90_000);

    it('a burst of 20 simultaneous Stop hooks starts exactly one drainer process', async () => {
      const { ingest, machine: m } = await onDemandMachine({ eventsDelayMs: 1500 });
      const sessions = [session(m), session(m), session(m), session(m)];
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          hook(m, 'Stop', sessions[i % sessions.length] as Session),
        ),
      );

      await until(() => queueDepth(m) === 0, 30_000, 'queue empty');
      await Bun.sleep(1_500);
      // Every drainer process logs one `drain.done`, a busy one included: a second
      // process would show up here even though it delivered nothing.
      expect(drainsFinished(m)).toBe(1);
      // Every event exactly once: two drainers would both have read the rows.
      const ids = ingest.events.map((e) => e.event_id);
      expect(new Set(ids).size).toBe(ids.length);
    }, 60_000);
  });

  // A refused port (or no token) must not turn every Stop into a drainer process: the
  // retry time only holds back rows that already failed, and each Stop adds a NEW due
  // row. (Measured before the spawn hold: 30 Stops 100 ms apart, 30 processes.)
  describe('a failing environment', () => {
    async function failFor(m: Machine, stops: number) {
      const s = session(m);
      for (let i = 0; i < stops; i++) {
        await hook(m, 'Stop', s);
        await Bun.sleep(100);
      }
      // Whatever drainers did start have finished.
      await until(
        () => holderOf(m) === null && spawnClaimed(m) === 0,
        20_000,
        'the drainers to finish',
      );
      return s;
    }

    it('spawns a small bounded number of drainers, however many hooks fire', async () => {
      const { ingest, machine: m } = await onDemandMachine();
      ingest.stop();
      m.setIngest('http://127.0.0.1:1'); // connection refused
      const s = await failFor(m, 25);

      const drainers = drainsFinished(m);
      expect(drainers).toBeGreaterThanOrEqual(1);
      expect(drainers).toBeLessThanOrEqual(3);
      expect(queueDepth(m)).toBeGreaterThanOrEqual(25);

      // The server comes back. The SessionEnd is the last chance for this session and
      // bypasses the hold: the ONE drainer it starts delivers the whole backlog (rows
      // deferred while the server was down included).
      const back = startIngest();
      extraIngests.push(back);
      m.setIngest(back.url);
      const queued = queueDepth(m);
      await hook(m, 'SessionEnd', s);
      await until(() => queueDepth(m) === 0, 30_000, 'the backlog to be delivered');
      expect(back.events.length).toBeGreaterThanOrEqual(queued);
      expect(back.events.some((e) => e.event_type === 'SessionEnd')).toBe(true);
    }, 90_000);

    it('without a token it is the same: a bounded number of drainers', async () => {
      const { machine: m } = await onDemandMachine();
      writeFileSync(join(m.aiotHome, 'identity.json'), '{}');
      await failFor(m, 20);
      expect(drainsFinished(m)).toBeLessThanOrEqual(3);
    }, 60_000);

    it('after the floor passes, the next ordinary Stop recovers the backlog', async () => {
      const { ingest, machine: m } = await onDemandMachine();
      ingest.stop();
      m.setIngest('http://127.0.0.1:1');
      const s = await failFor(m, 6);
      const back = startIngest();
      extraIngests.push(back);
      m.setIngest(back.url);

      // Inside the hold, an ordinary Stop is not given a drainer...
      const before = drainsFinished(m);
      await hook(m, 'Stop', s);
      await Bun.sleep(1_500);
      expect(drainsFinished(m)).toBe(before);
      expect(back.events.length).toBe(0);

      // ...and once the 30 s floor has passed, the next one is.
      await Bun.sleep(30_500);
      await hook(m, 'Stop', s);
      await until(() => queueDepth(m) === 0, 30_000, 'the backlog to be delivered');
      expect(back.events.length).toBeGreaterThanOrEqual(7);
    }, 120_000);
  });

  // (d) A drainer is not a daemon: whatever state it finds, it exits.
  describe('a drainer that cannot deliver exits promptly and keeps the data', () => {
    const cases: Array<{
      name: string;
      setup: (m: Machine, i: FakeIngest) => void;
      attempts: number;
      /** What a drainer that did NOT persist its backoff would get wrong. */
      retryTimeSet?: boolean;
    }> = [
      {
        attempts: 0,
        name: 'no auth token',
        setup: (m) => {
          writeFileSync(join(m.aiotHome, 'identity.json'), '{}');
        },
      },
      {
        attempts: 0,
        name: '401 from ingest',
        setup: (_m, i) => {
          i.opts.eventsStatus = 401;
        },
      },
      {
        attempts: 0,
        name: '429 from ingest',
        retryTimeSet: true,
        setup: (_m, i) => {
          i.opts.eventsStatus = 429;
        },
      },
      {
        attempts: 0,
        name: 'offline (connection refused)',
        retryTimeSet: true,
        setup: (m) => m.setIngest('http://127.0.0.1:1'),
      },
      {
        attempts: 1,
        name: '503 from ingest (a real server response: counted)',
        retryTimeSet: true,
        setup: (_m, i) => {
          i.opts.eventsStatus = 503;
        },
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        // Resident mode enqueues without spawning, so the drain below is the only one.
        const { ingest, machine: m } = residentMachine();
        const s = session(m);
        await hook(m, 'Stop', s);
        const queued = queueDepth(m);
        expect(queued).toBeGreaterThan(0);

        c.setup(m, ingest);
        const r = await aiot(m, ['drain']);
        expect(r.code).toBe(0);
        expect(r.stdout).toBe('');
        // Far inside the 120s cap — it stopped because it had nothing it could do.
        expect(r.ms).toBeLessThan(20_000);

        expect(queueDepth(m)).toBe(queued);
        const row = m.db(
          (db) =>
            db
              .query('SELECT MAX(attempts) AS a, MAX(next_attempt_at) AS n FROM events_queue')
              .get() as { a: number; n: string | null },
        );
        expect(row.a).toBe(c.attempts);
        expect(ingest.transcripts.size).toBe(0);

        // The retry time is ON DISK: the next process — which remembers nothing —
        // does not hammer a server that just answered 5xx/429 or was unreachable.
        if (c.retryTimeSet) {
          expect(row.n).not.toBeNull();
          const posts = ingest.eventRequests;
          const again = await aiot(m, ['drain']);
          expect(again.code).toBe(0);
          expect(ingest.eventRequests).toBe(posts);
        }

        // The foreground variant reports the same state and fails.
        const w = await aiot(m, ['drain', '--wait']);
        expect(w.code).toBe(1);
        expect(w.stdout).toContain('events remaining:');
        expect(w.ms).toBeLessThan(20_000);
        // The lease is released: nothing is left running.
        expect(holderOf(m)).toBeNull();
      }, 60_000);
    }

    // M3: a drainer has no memory, so a rejected token is remembered on disk — and,
    // like the resident flusher, a drainer must not age-expire rows while it has no
    // usable token.
    it('a rejected token is remembered across drainers, and old rows survive it', async () => {
      const { ingest, machine: m } = residentMachine();
      const s = session(m);
      await hook(m, 'Stop', s);

      ingest.opts.eventsStatus = 401;
      await aiot(m, ['drain']);
      // The 401 is on record, as a fingerprint of the token and never the token.
      const rec = m.db(
        (db) =>
          db.query('SELECT rejected_token_hash AS h, rejected_at AS at FROM drain_state').get() as {
            h: string | null;
            at: number | null;
          },
      );
      expect(rec.h).not.toBeNull();
      expect(rec.h).not.toContain('cct_');

      // A week and a day on, the rows are older than the 7-day horizon...
      const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
      m.db((db) => db.query('UPDATE events_queue SET ts = ?').run(old));
      const posts = ingest.eventRequests;
      const again = await aiot(m, ['drain']);
      expect(again.code).toBe(0);
      // ...and the drainer neither prunes them nor retries the rejected token.
      expect(queueDepth(m)).toBeGreaterThan(0);
      expect(ingest.eventRequests).toBe(posts);

      // After `aiot login` (a different token) the normal rules apply again at once —
      // which for rows past the 7-day horizon means they are finally dropped.
      ingest.opts.eventsStatus = 200;
      writeFileSync(
        join(m.aiotHome, 'identity.json'),
        JSON.stringify({ token: 'cct_e2e_token', user_id_claim: 'octocat' }),
      );
      m.db((db) => db.query('UPDATE drain_state SET rejected_token_hash = ?').run('0'.repeat(32)));
      const fixed = await aiot(m, ['drain']);
      expect(fixed.code).toBe(0);
      expect(queueDepth(m)).toBe(0);
    }, 90_000);
  });

  describe('upload volume and ordering', () => {
    // (f) The transcript is the whole redacted file each time. Stop fires per
    // response cycle, so shipping on every Stop would upload a growing file dozens
    // of times a session.
    it('does not re-upload the whole transcript on every Stop', async () => {
      const { ingest, machine: m } = await onDemandMachine();
      const s = session(m, 3);

      // Every Stop spawns its own drainer (the previous one has finished and let go
      // of the lease) — there is no manual drain anywhere in this test.
      for (let i = 0; i < 5; i++) {
        await hookAndSettle(m, 'Stop', s);
      }
      // Five Stops, one upload: the first ship, then none until the cadence allows.
      expect(completed(ingest, s)).toBe(1);
      expect(ingest.transcripts.get(s.id)?.bytes ?? 0).toBeGreaterThan(0);

      // SessionEnd is final: ship it now, and only it.
      await hookAndSettle(m, 'SessionEnd', s);
      expect(completed(ingest, s)).toBe(2);
      // And nothing is re-sent after that: a later session's hook finds no work.
      const other = session(m);
      await hookAndSettle(m, 'SessionStart', other);
      expect(completed(ingest, s)).toBe(2);
      expect(ingest.violations).toEqual([]);

      // Every event exactly once across all those drains.
      const ids = ingest.events.map((e) => e.event_id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(queueDepth(m)).toBe(0);
    }, 150_000);

    // A multi-chunk upload records progress on disk as it goes. The "was the
    // marker rewritten under me?" check used to read that progress as a rewrite, so
    // each such transcript cost a redundant full upload and a 409 before it healed.
    it('uploads a multi-chunk transcript once and clears its marker', async () => {
      const { ingest, machine: m } = await onDemandMachine();
      const s = session(m, 2, 1200);
      await hookAndSettle(m, 'Stop', s);

      expect(completed(ingest, s)).toBe(1);
      expect(ingest.transcripts.get(s.id)?.bytes).toBeGreaterThan(1024 * 1024);
      const marker = JSON.parse(
        readFileSync(join(m.aiotHome, 'ship-queue', `${s.id}.json`), 'utf8'),
      );
      expect(marker.dirty).toBe(false);
      expect(marker.bytes_uploaded).toBe(0);

      // Even a forced pass finds nothing owed.
      const w = await aiot(m, ['drain', '--wait']);
      expect(w.code).toBe(0);
      expect(completed(ingest, s)).toBe(1);
      expect(ingest.violations).toEqual([]);
    }, 60_000);

    it('ships a quiet session’s transcript at the first drain after it went idle', async () => {
      const { ingest, machine: m } = await onDemandMachine();
      const s = session(m, 3);
      await hookAndSettle(m, 'Stop', s);
      expect(completed(ingest, s)).toBe(1);

      // A second Stop, then the agent dies without a SessionEnd. Not shipped yet:
      // the last upload was seconds ago.
      await hookAndSettle(m, 'Stop', s);
      expect(completed(ingest, s)).toBe(1);

      // Hours later (the marker's last hook write is aged), another session starts
      // and its catch-up drainer ships it. That is the honest timing: the first
      // drain after the quiet period, which for a session that ended without
      // SessionEnd is the NEXT session.
      const marker = join(m.aiotHome, 'ship-queue', `${s.id}.json`);
      const parsed = JSON.parse(readFileSync(marker, 'utf8'));
      parsed.updated_at = new Date(Date.now() - 6 * 60_000).toISOString();
      writeFileSync(marker, JSON.stringify(parsed));
      await hookAndSettle(m, 'SessionStart', session(m));
      expect(completed(ingest, s)).toBe(2);
    }, 120_000);
  });

  // 5. Enrichment is written back once it has answered — and not before.
  describe('enrichment is stored with the row once, and only once it succeeded', () => {
    it('tags a retried event with the first attempt’s PR, not whatever is true later', async () => {
      const { ingest, machine: m } = residentMachine();
      const s = session(m);
      ingest.opts.eventsStatus = 503;
      await hook(m, 'SessionStart', s);
      const first = await aiot(m, ['drain', '--wait']);
      expect(first.code).toBe(1);
      expect(ghCalls(m, 'pr list')).toBeGreaterThanOrEqual(1);
      const lookups = ghCalls(m, 'pr list');
      const stored = m.db(
        (db) =>
          db
            .query('SELECT payload_json AS p, enriched FROM events_queue WHERE payload_json LIKE ?')
            .all(`%${s.id}%`) as Array<{ p: string; enriched: number }>,
      );
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.every((r) => r.enriched === 1)).toBe(true);
      expect(stored.every((r) => JSON.parse(r.p).session_context.git.pr_number === 42)).toBe(true);

      // The next day: the branch merged and a different PR owns that branch name.
      m.setGhPrNumber(99);
      ingest.opts.eventsStatus = 200;
      m.db((db) => db.query('UPDATE events_queue SET next_attempt_at = NULL').run());
      const second = await aiot(m, ['drain', '--wait']);
      expect(second.code).toBe(0);

      const delivered = ingest.events.filter((e) => e.session_id === s.id);
      expect(delivered.length).toBeGreaterThan(0);
      for (const e of delivered) {
        const git = (e.session_context as { git: { pr_number: number } }).git;
        expect(git.pr_number).toBe(42);
      }
      // The resolver was not asked again for the retried rows.
      expect(ghCalls(m, 'pr list')).toBe(lookups);
    }, 120_000);

    it('an event captured while the lookups fail (offline) is NOT stored as "no PR": it is enriched on the retry', async () => {
      const { ingest, machine: m } = residentMachine();
      const s = session(m);
      // Offline: gh fails and so does delivery.
      m.setGhFailing(true);
      ingest.opts.eventsStatus = 503;
      await hook(m, 'SessionStart', s);
      const offline = await aiot(m, ['drain', '--wait']);
      expect(offline.code).toBe(1);
      const stored = m.db(
        (db) =>
          db
            .query('SELECT payload_json AS p, enriched FROM events_queue WHERE payload_json LIKE ?')
            .all(`%${s.id}%`) as Array<{ p: string; enriched: number }>,
      );
      expect(stored.length).toBeGreaterThan(0);
      // Still open: nothing answered, so nothing is final.
      expect(stored.every((r) => r.enriched === 0)).toBe(true);
      expect(stored.every((r) => JSON.parse(r.p).session_context.git.pr_number == null)).toBe(true);

      // Back online. The retry resolves what the first attempt could not.
      m.setGhFailing(false);
      ingest.opts.eventsStatus = 200;
      m.db((db) => db.query('UPDATE events_queue SET next_attempt_at = NULL').run());
      const online = await aiot(m, ['drain', '--wait']);
      expect(online.code).toBe(0);
      const delivered = ingest.events.filter((e) => e.session_id === s.id);
      expect(delivered.length).toBeGreaterThan(0);
      for (const e of delivered) {
        expect((e.session_context as { git: { pr_number: number } }).git.pr_number).toBe(42);
      }
    }, 120_000);
  });

  // (g) Every delivery process coordinates through the leases.
  describe('contention for the delivery leases', () => {
    const dirtyMarkers = (m: Machine) => {
      const dir = join(m.aiotHome, 'ship-queue');
      if (!existsSync(dir)) {
        return 0;
      }
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .filter((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).dirty !== false).length;
    };

    async function contend(withImport: boolean) {
      const { ingest: server, machine: m } = residentMachine({
        chunkDelayMs: 250,
        eventsDelayMs: 150,
      });

      // Three sessions with ~2.4 MB of word noise each: about 1.5 MB compressed, two chunks.
      const sessions = [session(m, 2, 1200), session(m, 2, 1200), session(m, 2, 1200)];
      for (const s of sessions) {
        await hook(m, 'Stop', s);
      }
      const queued = queueDepth(m);
      expect(queued).toBeGreaterThan(0);

      const procs = [
        Bun.spawn([m.aiot, 'flusher'], { env: m.env, stderr: 'ignore', stdout: 'ignore' }),
        ...[0, 1, 2].map(() =>
          Bun.spawn([m.aiot, 'drain'], { env: m.env, stderr: 'ignore', stdout: 'ignore' }),
        ),
        // Imports the same sessions from the same transcripts, in one unchunked POST
        // each.
        ...(withImport
          ? [
              Bun.spawn([m.aiot, 'import', '--quiet'], {
                env: { ...m.env, CLAUDE_PROJECTS_DIR: join(m.home, '.claude', 'projects') },
                stderr: 'ignore',
                stdout: 'ignore',
              }),
            ]
          : []),
      ];
      children.push(...procs);

      // The resident shipper sweeps once at start and then every 10 minutes, and a
      // transcript uploaded before its session's events 404s until that next sweep.
      // That ordering is real but orthogonal to what this test is about, so start the
      // shipper once the events are in — while the drainers are still mid-transcript.
      await until(() => server.events.length >= queued, 30_000, 'events in');
      children.push(
        Bun.spawn([m.aiot, 'shipper'], { env: m.env, stderr: 'ignore', stdout: 'ignore' }),
      );

      await until(
        () =>
          sessions.every((s) => completed(server, s) >= 1) &&
          queueDepth(m) === 0 &&
          dirtyMarkers(m) === 0,
        90_000,
        'everything delivered',
      );
      // Give any straggler that would double-ship its chance to.
      await Bun.sleep(2500);

      const counts = new Map<unknown, number>();
      for (const e of server.events) {
        counts.set(e.event_id, (counts.get(e.event_id) ?? 0) + 1);
      }
      return { counts, ingest: server, sessions };
    }

    it('flusher, shipper and three drainers deliver every event and every chunk once', async () => {
      const { counts, ingest } = await contend(false);
      expect(ingest.violations).toEqual([]);
      expect([...counts.values()].every((n) => n === 1)).toBe(true);
    }, 150_000);

    it('adding an import to the mix never interleaves a transcript upload', async () => {
      const { counts, ingest } = await contend(true);
      expect(ingest.violations).toEqual([]);
      // `import` synthesizes events with the same deterministic ids as the hook, so
      // the server sees an id twice by design (and dedupes it). A SECOND queue
      // process shipping the same rows would make it three.
      expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    }, 150_000);

    // The contention above does not FORCE an overlap: a shipper that started a
    // moment later than the drainers might simply find nothing to do. This one
    // does — the shipper starts while a drainer is provably mid-upload of the very
    // session the shipper would pick first.
    it('a resident shipper started mid-upload does not upload the drainer’s session', async () => {
      const { ingest, machine: m } = residentMachine({ chunkDelayMs: 700 });
      const sessions = [session(m, 2, 1200), session(m, 2, 1200)];
      for (const s of sessions) {
        await hook(m, 'Stop', s);
      }
      children.push(
        Bun.spawn([m.aiot, 'drain'], { env: m.env, stderr: 'ignore', stdout: 'ignore' }),
      );
      await until(
        () => [...ingest.transcripts.values()].some((a) => a.assembling),
        30_000,
        'a drainer mid-upload',
      );
      // Mid-upload, with several chunk delays still to run: start the shipper.
      children.push(
        Bun.spawn([m.aiot, 'shipper'], { env: m.env, stderr: 'ignore', stdout: 'ignore' }),
      );
      await until(() => sessions.every((s) => completed(ingest, s) >= 1), 60_000, 'both uploaded');
      await Bun.sleep(1_500);
      expect(ingest.violations).toEqual([]);
      for (const s of sessions) {
        expect(completed(ingest, s)).toBe(1);
      }
    }, 120_000);

    // The persisted retry time is the DRAINER's memory. The resident flusher keeps the
    // in-memory backoff it always had and must not be delayed a second time by a
    // retry time a drainer left on a row.
    it('a resident flusher delivers rows a drainer deferred: it ignores the persisted retry time', async () => {
      const { ingest, machine: m } = residentMachine();
      const s = session(m);
      await hook(m, 'Stop', s);
      const queued = queueDepth(m);
      expect(queued).toBeGreaterThan(0);
      const later = new Date(Date.now() + 60 * 60_000).toISOString();
      m.db((db) => db.query('UPDATE events_queue SET next_attempt_at = ?').run(later));

      children.push(
        Bun.spawn([m.aiot, 'flusher'], { env: m.env, stderr: 'ignore', stdout: 'ignore' }),
      );
      await until(() => ingest.events.length >= queued, 20_000, 'the flusher to deliver');
      await until(() => queueDepth(m) === 0, 10_000, 'queue empty');
    }, 60_000);

    // No token: the resident flusher must not touch the lease table every tick for
    // nothing (each touch is a write that contends with the hook).
    it('a resident flusher with no token never takes the events lease', async () => {
      const { machine: m } = residentMachine();
      const s = session(m);
      await hook(m, 'Stop', s);
      writeFileSync(join(m.aiotHome, 'identity.json'), '{}');
      expect(queueDepth(m)).toBeGreaterThan(0);

      children.push(
        Bun.spawn([m.aiot, 'flusher'], { env: m.env, stderr: 'ignore', stdout: 'ignore' }),
      );
      await until(
        () => logHas(m, 'flusher.no_token'),
        15_000,
        'the flusher to notice it has no token',
      );
      await Bun.sleep(1_000);
      const row = m.db(
        (db) =>
          db.query("SELECT started_at AS t FROM delivery_lease WHERE kind = 'events'").get() as {
            t: number | null;
          },
      );
      expect(row.t).toBeNull();
    }, 60_000);
  });

  describe('lifecycle commands stop the drainer, and uninstall switches spawning off', () => {
    it('uninstall resets the mode first, stops a live drainer, and hooks that survive it spawn nothing', async () => {
      const { ingest, machine: m } = await onDemandMachine({ eventsDelayMs: 20_000 });
      const s = session(m);
      await hook(m, 'Stop', s);
      await until(() => ingest.eventRequests >= 1, 20_000, 'drainer in flight');
      const pid = holderOf(m)?.pid ?? 0;
      expect(pid).toBeGreaterThan(0);
      expect(pidGone(pid)).toBe(false);

      const r = await aiot(m, ['uninstall']);
      expect(r.code).toBe(0);
      await until(() => pidGone(pid), 10_000, 'drainer gone');
      expect(modeOf(m)).toBe('resident');

      // A hook the remover missed (a pasted snippet, project-level or MDM-managed
      // settings) still fires — and must neither spawn a drainer nor ship.
      const before = ingest.eventRequests;
      await hook(m, 'Stop', s);
      expect(spawnClaimed(m)).toBe(0);
      await Bun.sleep(1_000);
      expect(ingest.eventRequests).toBe(before);
    }, 60_000);

    it('purge-local stops a live drainer and keeps the mode', async () => {
      const { ingest, machine: m } = await onDemandMachine({ eventsDelayMs: 20_000 });
      const s = session(m);
      await hook(m, 'Stop', s);
      await until(() => ingest.eventRequests >= 1, 20_000, 'drainer in flight');
      const pid = holderOf(m)?.pid ?? 0;
      expect(pid).toBeGreaterThan(0);
      expect(pidGone(pid)).toBe(false);

      const purge = await aiot(m, ['purge-local', '--yes']);
      expect(purge.code).toBe(0);
      await until(() => pidGone(pid), 10_000, 'drainer gone');
      expect(modeOf(m)).toBe('on-demand');
    }, 60_000);

    it('purge-local leaves an idle resident flusher following the NEW queue.db', async () => {
      // An idle flusher holds no lease, so purge has nothing to stop; its one
      // connection used to stay on the unlinked file, and every event after the
      // purge sat in the new queue forever.
      const { ingest, machine: m } = residentMachine();
      const flusher = Bun.spawn([m.aiot, 'flusher'], {
        env: m.env,
        stderr: 'ignore',
        stdout: 'ignore',
      });
      children.push(flusher);
      await until(() => logHas(m, '"flusher.start"'), 10_000, 'flusher up');
      const before = session(m);
      await hook(m, 'Stop', before);
      await until(
        () => ingest.events.length > 0 && queueDepth(m) === 0,
        20_000,
        'first session delivered',
      );
      const delivered = ingest.events.length;

      expect((await aiot(m, ['purge-local', '--yes'])).code).toBe(0);
      // purge removed the login too; the machine is logged in again, as a user would.
      m.login();
      const after = session(m);
      await hook(m, 'Stop', after);
      expect(queueDepth(m)).toBeGreaterThan(0);

      await until(
        () => queueDepth(m) === 0 && ingest.events.length > delivered,
        20_000,
        'the post-purge session delivered by the same flusher',
      );
      expect(ingest.events.slice(delivered).every((e) => e.session_id === after.id)).toBe(true);
      expect(pidGone(flusher.pid)).toBe(false);
      expect(logHas(m, '"flusher.queue_replaced"')).toBe(true);
    }, 60_000);

    it('switching to resident stops the drainer', async () => {
      const { ingest, machine: m } = await onDemandMachine({ eventsDelayMs: 20_000 });
      const s = session(m);
      await hook(m, 'Stop', s);
      await until(() => ingest.eventRequests >= 1, 20_000, 'drainer in flight');
      const pid = holderOf(m)?.pid ?? 0;
      expect(pid).toBeGreaterThan(0);

      const r = await aiot(m, [
        'install',
        '--mode',
        'resident',
        '--no-start',
        '--no-auto',
        '--force',
      ]);
      expect(r.code).toBe(0);
      await until(() => pidGone(pid), 10_000, 'drainer gone');
    }, 60_000);
  });
});
