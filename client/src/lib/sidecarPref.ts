/**
 * "Show sidecar files" (Godot `*.gd.uid`, `*.gdshader.uid`). Off by default:
 * the server hides them from the file tree and the filename palettes unless
 * the request says `sidecars=show`. Interface preference, so it lives in
 * localStorage like the other explorer toggles (shipyard:explorer-*).
 */
const KEY = 'shipyard:explorer-show-sidecars'

export function readShowSidecars(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function writeShowSidecars(show: boolean): void {
  try {
    localStorage.setItem(KEY, show ? '1' : '0')
  } catch {
    /* storage blocked: the toggle still works for this session */
  }
}
