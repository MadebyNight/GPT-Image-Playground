import { describe, expect, it } from 'vitest'
import { TEMPLATE_SAMPLES } from './templateSamples'

const expectedSourceIds = [
  'task-004',
  'task-013',
  'task-001',
  'task-025',
  'task-038',
  'task-024',
]

const expectedOutput = {
  'task-004': { ratio: '1:1', size: '1254x1254', requiresReference: false },
  'task-013': { ratio: '1:1', size: '1254x1254', requiresReference: true },
  'task-001': { ratio: '2:1', size: '1778x884', requiresReference: true },
  'task-025': { ratio: '1:1', size: '1254x1254', requiresReference: true },
  'task-038': { ratio: '1:1', size: '1254x1254', requiresReference: false },
  'task-024': { ratio: '2:1', size: '1774x887', requiresReference: true },
} as const

const expectedKeys = [
  'alt',
  'category',
  'id',
  'imageSrc',
  'prompt',
  'ratio',
  'requiresReference',
  'size',
  'sourceSampleId',
  'title',
]

describe('template samples', () => {
  it('contains the six approved samples with unique identifiers', () => {
    expect(TEMPLATE_SAMPLES).toHaveLength(6)
    expect(new Set(TEMPLATE_SAMPLES.map((sample) => sample.id)).size).toBe(6)
    expect(TEMPLATE_SAMPLES.map((sample) => sample.sourceSampleId)).toEqual(expectedSourceIds)
  })

  it('only exposes the approved data fields and fills required text', () => {
    for (const sample of TEMPLATE_SAMPLES) {
      expect(Object.keys(sample).sort()).toEqual(expectedKeys)
      expect(sample.title.trim()).not.toBe('')
      expect(sample.category.trim()).not.toBe('')
      expect(sample.prompt.trim()).not.toBe('')
      expect(sample.alt.trim()).not.toBe('')
    }
  })

  it('uses deploy-safe image URLs and the approved output metadata', () => {
    for (const sample of TEMPLATE_SAMPLES) {
      expect(sample.imageSrc).toBe(
        `${import.meta.env.BASE_URL}templates/${sample.sourceSampleId}.webp`,
      )
      expect({
        ratio: sample.ratio,
        size: sample.size,
        requiresReference: sample.requiresReference,
      }).toEqual(expectedOutput[sample.sourceSampleId as keyof typeof expectedOutput])
    }

    expect(TEMPLATE_SAMPLES.filter((sample) => sample.requiresReference)).toHaveLength(4)
  })
})
