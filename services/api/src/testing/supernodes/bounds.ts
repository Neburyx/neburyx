/** The page the product asks for by default. */
export const PAGE = 25;
/** The largest page the gate allows by default (`max_page`). */
export const MAX_PAGE = 50;
/** What an edge may add to the serialized size of a page. */
export const BYTES_PER_EDGE = 4_000;
export const PAGE_BYTES = PAGE * BYTES_PER_EDGE;
/** The answer to a degree preview holds counts and type names, never neighbors. */
export const PREVIEW_BYTES = 16_000;

export interface PageShape {
  readonly edges: readonly unknown[];
  readonly nodes: readonly unknown[];
}

/** Fails when a page holds more than `limit` edges or `limit + 1` nodes, or serializes to `bytes` or more. */
export function checkPageBounds(page: PageShape, limit: number, where: string, bytes: number = limit * BYTES_PER_EDGE): void {
  if (page.edges.length > limit) throw new Error(`${where}: ${page.edges.length} edges, over the page of ${limit}`);
  if (page.nodes.length > limit + 1) throw new Error(`${where}: ${page.nodes.length} nodes, over ${limit + 1}`);
  const size = JSON.stringify(page).length;
  if (size >= bytes) throw new Error(`${where}: ${size} bytes serialized, not under the limit of ${bytes}`);
}

/** Fails when the answer of a degree preview is `bytes` or more once serialized. */
export function checkPreviewBounds(preview: unknown, where: string, bytes: number = PREVIEW_BYTES): void {
  const size = JSON.stringify(preview).length;
  if (size >= bytes) throw new Error(`${where}: ${size} bytes serialized, not under the limit of ${bytes}`);
}
