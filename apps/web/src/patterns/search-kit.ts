import type { ApiResult } from '../api/client.js';
import type { SearchResult } from '@neburyx/contracts';
import { answerOf } from '../search/search-test-kit.js';
import type { GraphNode } from '@neburyx/contracts';

/** A search answer holding the given nodes as its exact hits. */
export const searchOf = async (nodes: readonly GraphNode[]): Promise<ApiResult<SearchResult>> => ({ ok: true, value: answerOf('a', nodes) });
