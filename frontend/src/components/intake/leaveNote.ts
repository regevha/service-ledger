/** Whether it is safe to leave this page: not while the scan is still being sent; afterwards the server carries on alone. */
export function leaveNote(uploading: boolean, online: boolean): string {
  if (uploading) {
    return online
      ? 'Keep this page open until the scan has been sent.'
      : 'You are offline, so the scan cannot be sent yet. Keep this page open; try again when the connection is back.';
  }
  return online
    ? 'You can leave this tab; the report keeps reading in the background.'
    : 'You are offline, so this page cannot show progress. The scan is already sent and the report keeps reading; it is safe to leave. Check Reports when you are back online.';
}
