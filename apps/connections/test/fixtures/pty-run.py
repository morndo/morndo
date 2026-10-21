# Runs a command with a pseudo-terminal as its stdio and its controlling terminal, reads its first output, then closes the
# terminal's master end, as a window closing does: the command's next write fails with EIO and its session gets SIGHUP. Prints the
# command's exit code (negative: the signal that ended it) on one line.
import os, pty, select, sys

pid, master = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
ready, _, _ = select.select([master], [], [], 20)
if ready:
    os.read(master, 4096)
os.close(master)
_, status = os.waitpid(pid, 0)
print(os.waitstatus_to_exitcode(status))
