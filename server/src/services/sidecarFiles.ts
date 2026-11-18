/**
 * Godot writes a `<script>.uid` next to each script and shader. They are
 * generated, not authored, so the file tree and the filename palettes hide
 * them unless the user asks to see them (`show sidecar files`).
 *
 * Only these two patterns. Other Godot files (.tscn, .tres, .import, .godot)
 * are not sidecars and stay visible as before.
 */
export function isSidecarFile(name: string): boolean {
  return /\.(gd|gdshader)\.uid$/i.test(name);
}
