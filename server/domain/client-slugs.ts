export const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

export const buildClientSlug = (name: string, clientId: string) =>
  `${slugify(name)}-${clientId.slice(0, 6)}`;
