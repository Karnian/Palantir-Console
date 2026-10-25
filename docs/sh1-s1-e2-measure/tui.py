import os, pty, sys, time, select, re, signal
cmd = open('handoff-command.txt').read().strip()
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.execv('/bin/zsh', ['/bin/zsh', '-c', cmd])
out = b''
def pump(seconds):
    global out
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: out += os.read(fd, 65536)
            except OSError: return
pump(12)
os.write(fd, b'/exit\r')
pump(6)
try: os.kill(pid, signal.SIGTERM)
except ProcessLookupError: pass
text = re.sub(rb'\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]', b'', out).decode('utf8', 'replace')
open('tui-output.txt', 'w').write(text)
flat = ' '.join(text.split())
print('bytes', len(out)); print('has alpha:', 'alpha' in flat); print('trust prompt:', 'trust' in flat.lower()); print(flat[:600]); print('...'); print(flat[-600:])
