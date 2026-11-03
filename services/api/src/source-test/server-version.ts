/** The text for a server: `Neo4j <version>` for the Neo4j kernel and `<product> <version>` for any other product. */
export function serverVersionText(server: { readonly product: string; readonly version: string }): string {
  const product = server.product === 'Neo4j Kernel' ? 'Neo4j' : server.product;
  return `${product} ${server.version}`;
}
