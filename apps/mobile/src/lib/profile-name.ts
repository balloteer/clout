export function profileName(handle?: string) {
  return handle?.toLowerCase().endsWith('.skr') ? handle.slice(0, -4) : handle
}
