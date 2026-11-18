/**
 * Testing workspace discovery: test scenes are the .tscn files under tests/ (evidence: the file is there); a .gd under
 * tests/ that no test scene attaches is a candidate only and is never reported as runnable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listTestScenes, listUnattachedTestScripts } from '../src/services/godot/runs.js'

test('tests/ discovery separates attached-to-scene scripts from unattached candidates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'godot-testing-'))
  try {
    mkdirSync(join(root, 'tests', 'nested'), { recursive: true })
    mkdirSync(join(root, 'scenes'), { recursive: true })
    writeFileSync(join(root, 'tests', 'traversal_playtest.gd'), 'extends Node\n')
    writeFileSync(join(root, 'tests', 'helper.gd'), 'extends Node\n')
    writeFileSync(join(root, 'tests', 'traversal_playtest.tscn'),
      '[gd_scene format=3]\n[ext_resource type="Script" path="res://tests/traversal_playtest.gd" id="1"]\n')
    writeFileSync(join(root, 'tests', 'nested', 'empty.tscn'), '[gd_scene format=3]\n')
    writeFileSync(join(root, 'scenes', 'stair_traversal.tscn'), '[gd_scene format=3]\n')

    const scenes = await listTestScenes(root)
    assert.deepEqual(scenes, ['tests/nested/empty.tscn', 'tests/traversal_playtest.tscn'])
    assert.ok(!scenes.some(s => s.startsWith('scenes/')), 'scenes outside tests/ are not test scenes')

    const candidates = await listUnattachedTestScripts(root, scenes)
    assert.deepEqual(candidates, ['tests/helper.gd'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
