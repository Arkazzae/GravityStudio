const MAX_IMAGE_BYTES = 20 * 1024 ** 2;

export function imageFileProblem(files: readonly File[]): string | undefined {
  if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) return 'Choose PNG, JPEG, or WebP images.';
  if (files.some(file => !file.size || file.size > MAX_IMAGE_BYTES)) return 'Choose non-empty images up to 20 MiB each.';
}
