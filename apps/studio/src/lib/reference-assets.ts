import type { InputImage, Job } from './api.ts';

export type SavedReference = { type: 'input'; input: InputImage } | { type: 'output'; jobId: string; outputId: string };

export function referenceKey(reference: SavedReference): string {
  if (reference.type === 'input') return reference.input.source
    ? referenceKey({ type: 'output', ...reference.input.source }) : `input:${reference.input.id}`;
  return `output:${reference.jobId}:${reference.outputId}`;
}

/** A generated image and its reusable reference are one asset in the library. */
export function visibleImportedImages(inputs: InputImage[], jobs: Job[]): InputImage[] {
  const outputs = new Set(jobs.flatMap(job => job.outputs.filter(output => output.mimeType.startsWith('image/')).map(output => `output:${job.id}:${output.id}`)));
  return inputs.filter(input => !input.source || !outputs.has(referenceKey({ type: 'input', input })));
}

export function appendReferences(current: InputImage[], added: InputImage[]): InputImage[] {
  const seen = new Set(current.map(input => referenceKey({ type: 'input', input })));
  return [...current, ...added.filter(input => {
    const key = referenceKey({ type: 'input', input });
    if (seen.has(key)) return false;
    seen.add(key); return true;
  })];
}
