/**
 * Runs an interactive terminal program in a real pseudo-terminal (through Python's `pty` module: no native Node dependency) and reports what it showed.
 * Used by the live tests that drive a real tool's TUI (Codex, Muse); those tests skip themselves when Python or the tool is missing, so CI stays green.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DRIVER = String.raw`
import os, pty, re, select, sys, time, fcntl, termios, struct, signal, json
spec = json.loads(sys.argv[1])
ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]|\x1b[=>]')
pid, fd = pty.fork()
if pid == 0:
    os.chdir(spec['cwd'])
    env = dict(spec['env'])  # EMPTY base: never the caller's environment (it may name the owner's live Herdr, tmux or agent sessions)
    os.execvpe(spec['cmd'][0], spec['cmd'], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 140, 0, 0))
start = time.time(); buf = ''; events = []
sends = [[re.compile(s.get('pattern') or '$^'), s['keys'].encode('latin1').decode('unicode_escape').encode('latin1'), False, s.get('at')] for s in spec['sends']]
stop = [re.compile(p) for p in spec.get('stopOn', [])]
marks = [[re.compile(m), False, m] for m in spec.get('marks', [])]
while time.time() - start < spec['seconds']:
    if spec.get('stopFile') and os.path.exists(spec['stopFile']):
        time.sleep(spec.get('settle', 0.5)); break
    r, _, _ = select.select([fd], [], [], 0.2)
    for s in sends:
        if not s[2] and s[3] is not None and time.time() - start >= s[3]:
            s[2] = True; events.append({'t': round(time.time() - start, 2), 'send': 'at %s' % s[3]}); os.write(fd, s[1])
    if r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        buf += ANSI.sub('', data.decode('utf8', 'replace'))
        for m in marks:
            if not m[1] and m[0].search(buf):
                m[1] = True; events.append({'t': round(time.time() - start, 2), 'mark': m[2]})
        for s in sends:
            if not s[2] and s[3] is None and s[0].search(buf):
                s[2] = True; events.append({'t': round(time.time() - start, 2), 'send': s[0].pattern}); os.write(fd, s[1])
        if any(p.search(buf) for p in stop):
            time.sleep(spec.get('settle', 0.5)); break
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass
open(spec['out'], 'w').write(json.dumps({'screen': buf[-20000:], 'events': events, 'seconds': round(time.time() - start, 2)}))
`;

export const havePython = (): boolean => { try { return spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0; } catch { return false; } };

export interface PtyRun { cmd: string[]; cwd: string; env: Record<string, string>; seconds: number; sends?: { pattern?: string; at?: number; keys: string }[]; stopOn?: string[]; settle?: number;
  /** regexes whose first appearance on the screen is timed (events `{t, mark}`) */
  marks?: string[];
  /** the run ends (after `settle`) once this file exists: lets the caller end it from outside */
  stopFile?: string }
export interface PtyResult { screen: string; events: { t: number; send?: string; mark?: string }[]; seconds: number }

/** starts the program in a pty; resolves when it has been stopped (after `seconds`, or once a `stopOn` pattern showed) */
export function ptyRun(r: PtyRun): Promise<PtyResult> {
  const dir = mkdtempSync(join(tmpdir(), 'bwc-pty-'));
  const out = join(dir, 'out.json');
  writeFileSync(join(dir, 'driver.py'), DRIVER);
  return new Promise((resolve, reject) => {
    const p = spawn('python3', ['-I', join(dir, 'driver.py'), JSON.stringify({ ...r, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', ...r.env }, sends: r.sends ?? [], out })], { stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', () => { try { resolve(JSON.parse(readFileSync(out, 'utf8')) as PtyResult); } catch (e) { reject(e as Error); } finally { rmSync(dir, { recursive: true, force: true }); } });
  });
}
