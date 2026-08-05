export function readPath(value, path) {
  if (!path) return value;
  return String(path)
    .split('.')
    .reduce((current, part) => current?.[part], value);
}

export function interpolatePath(template, context) {
  return String(template).replace(/\{([^}]+)\}/g, (_, key) => {
    const resolved = readPath(context, key);
    if (resolved === undefined) throw new Error(`Path value was not resolved: ${key}`);
    return encodeURIComponent(String(resolved));
  });
}

export function capturePaths(value, mapping = {}) {
  return Object.fromEntries(
    Object.entries(mapping).map(([name, path]) => [name, readPath(value, path)])
  );
}
