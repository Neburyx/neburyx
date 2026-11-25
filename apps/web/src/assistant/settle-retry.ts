/** How long to wait before each further read after another window changed or answered a turn and what is read does not show it yet: the server stores a turn a moment after it has answered. After the last wait the read stops and the view is left as read. */
export const SETTLE_RETRY_MS: readonly number[] = [600, 1500, 3000];
