const REVOKE_DELAY_MS = 10_000;

/** Hands the file to the browser under the server's name. */
export function saveFile(file: { readonly blob: Blob; readonly filename: string }): void {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // some browsers cancel a download whose URL is revoked at once
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
