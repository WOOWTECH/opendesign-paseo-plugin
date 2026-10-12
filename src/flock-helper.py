"""Bridge-private Linux flock; lock belongs to the inherited open description."""
import errno
import fcntl
import sys


def main(argv):
    if argv != ["--exclusive", "--nonblock", "--conflict-exit-code", "73", "3"]:
        return 70
    try:
        fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return 0
    except OSError as error:
        return 73 if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK) else 70


sys.exit(main(sys.argv[1:]))
