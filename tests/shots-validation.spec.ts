import { test, expect } from '@playwright/test'
import { sanitizeEnum, parseRawShots, isUsableShot } from '../src/app/api/projects/[id]/shots/logic'

const SHOT_SIZES = ['wide', 'full', 'medium', 'close_up', 'extreme_close_up'] as const

test.describe('write_shots validation', () => {
  test('sanitizeEnum nulls an unrecognized value instead of rejecting the shot', () => {
    expect(sanitizeEnum('wide', SHOT_SIZES)).toBe('wide')
    expect(sanitizeEnum('panoramic', SHOT_SIZES)).toBeNull()
    expect(sanitizeEnum(null, SHOT_SIZES)).toBeNull()
    expect(sanitizeEnum(42, SHOT_SIZES)).toBeNull()
  })

  test('a shot is usable if it has narration or a visual, or both', () => {
    expect(
      isUsableShot({
        voice_over: 'The Taj Mahal stands in Agra.',
        visual_description: '',
        shot_size: null,
        camera_angle: null,
        camera_movement: null,
        duration_sec: null,
        section_label: null,
        dialogue: [],
        element_names: [],
      })
    ).toBe(true)

    expect(
      isUsableShot({
        voice_over: '',
        visual_description: '',
        shot_size: null,
        camera_angle: null,
        camera_movement: null,
        duration_sec: null,
        section_label: null,
        dialogue: [],
        element_names: [],
      })
    ).toBe(false)
  })

  test('parseRawShots drops shots with neither narration nor a visual, keeps the rest', () => {
    const rawShots = [
      {
        voice_over: 'The Taj Mahal, a symbol of love, stands in Agra.',
        visual_description: 'Wide shot of the Taj Mahal at sunrise.',
        shot_size: 'wide',
        camera_angle: 'eye_level',
        camera_movement: 'static',
        duration_sec: 5,
        section_label: 'Introduction',
        dialogue: [],
        element_names: [{ name: 'Taj Mahal', type: 'location', description: 'A white marble mausoleum.' }],
      },
      {
        voice_over: '',
        visual_description: '',
        shot_size: 'wide',
        camera_angle: 'eye_level',
        camera_movement: 'static',
        duration_sec: 5,
        section_label: 'Introduction',
        dialogue: [],
        element_names: [],
      },
    ]

    const result = parseRawShots(rawShots)
    expect(result).toHaveLength(1)
    expect(result[0].voice_over).toContain('Taj Mahal')
    expect(result[0].element_names).toEqual([
      { name: 'Taj Mahal', type: 'location', description: 'A white marble mausoleum.' },
    ])
  })

  test('parseRawShots drops malformed dialogue lines and element refs rather than the whole shot', () => {
    const rawShots = [
      {
        voice_over: 'Workers lift the stone.',
        visual_description: 'Workers at the construction site.',
        shot_size: null,
        camera_angle: null,
        camera_movement: null,
        duration_sec: 6,
        section_label: 'Foundation',
        dialogue: [{ speaker_name: 'Worker' }, { speaker_name: 'Worker', line: 'Lift on three.' }],
        element_names: [{ name: '' }, { name: 'Workers', type: 'character', description: 'Construction crew.' }],
      },
    ]

    const result = parseRawShots(rawShots)
    expect(result).toHaveLength(1)
    expect(result[0].dialogue).toEqual([{ speaker_name: 'Worker', line: 'Lift on three.' }])
    expect(result[0].element_names).toEqual([
      { name: 'Workers', type: 'character', description: 'Construction crew.' },
    ])
  })
})
