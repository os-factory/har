export function saveFilter(existing, filter) {
  if (!filter.name.trim()) throw new Error('A saved filter needs a name');
  const duplicate = existing.some(
    (item) => item.name.toLowerCase() === filter.name.trim().toLowerCase(),
  );
  if (duplicate) throw new Error(`A filter named "${filter.name}" already exists`);
  return [...existing, { ...filter, name: filter.name.trim() }];
}
