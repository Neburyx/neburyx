/** How long a read of the list may wait for an answer before it is given up as a failure with Try again: the list comes from this server's own database, so 15 seconds of silence is a server that is not answering. One wait covers the whole read, which for a reread is up to the pages it keeps. */
export const READ_WAIT_MS = 15_000;
