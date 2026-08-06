import { readFile } from 'node:fs/promises';
import path from 'node:path';

const skillPath = path.resolve(process.argv[2] ?? 'skills/testloop/SKILL.md');
const content = await readFile(skillPath, 'utf8');
const errors = validateSkill(content, skillPath);

if (errors.length > 0) {
  for (const error of errors) console.error(`Skill validation error: ${error}`);
  process.exit(1);
}

console.log(`Agent Skills specification validated: ${path.relative(process.cwd(), skillPath)}`);

function validateSkill(source, filename) {
  const errors = [];
  const normalized = source.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return ['SKILL.md must contain YAML frontmatter followed by Markdown content.'];

  const [, frontmatter, body] = match;
  const parsed = parseFrontmatter(frontmatter, errors);
  const allowedFields = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

  for (const field of Object.keys(parsed)) {
    if (!allowedFields.has(field)) errors.push(`unsupported frontmatter field: ${field}`);
  }

  const name = parsed.name;
  const description = parsed.description;
  const compatibility = parsed.compatibility;
  const folderName = path.basename(path.dirname(filename));

  if (typeof name !== 'string' || name.length === 0) {
    errors.push('name is required.');
  } else {
    if (name.length > 64) errors.push('name must be at most 64 characters.');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      errors.push('name must contain only lowercase letters, numbers, and single hyphen separators.');
    }
    if (name !== folderName) errors.push(`name must match the skill folder name (${folderName}).`);
  }

  if (typeof description !== 'string' || description.trim().length === 0) {
    errors.push('description is required and must be non-empty.');
  } else if (description.length > 1024) {
    errors.push('description must be at most 1024 characters.');
  }

  if (compatibility !== undefined && (typeof compatibility !== 'string' || compatibility.length < 1 || compatibility.length > 500)) {
    errors.push('compatibility must be a string between 1 and 500 characters.');
  }

  if (parsed.metadata !== undefined) {
    if (typeof parsed.metadata !== 'object' || Array.isArray(parsed.metadata) || parsed.metadata === null) {
      errors.push('metadata must be a key-value mapping.');
    } else {
      for (const [key, value] of Object.entries(parsed.metadata)) {
        if (typeof value !== 'string') errors.push(`metadata.${key} must be a string.`);
      }
    }
  }

  if (parsed['allowed-tools'] !== undefined && typeof parsed['allowed-tools'] !== 'string') {
    errors.push('allowed-tools must be a space-separated string.');
  }

  if (body.trim().length === 0) errors.push('Markdown instruction body must be non-empty.');
  if (normalized.split('\n').length > 500) errors.push('SKILL.md should remain under 500 lines for progressive disclosure.');

  return errors;
}

function parseFrontmatter(frontmatter, errors) {
  const result = {};
  const lines = frontmatter.split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    if (/^\s/.test(line)) {
      errors.push(`unexpected indentation at frontmatter line ${index + 1}.`);
      index += 1;
      continue;
    }

    const fieldMatch = line.match(/^([a-z][a-z0-9-]*):(?:\s*(.*))?$/);
    if (!fieldMatch) {
      errors.push(`invalid frontmatter syntax at line ${index + 1}.`);
      index += 1;
      continue;
    }

    const [, key, rawValue = ''] = fieldMatch;
    if (Object.hasOwn(result, key)) errors.push(`duplicate frontmatter field: ${key}`);

    if (rawValue === '>' || rawValue === '|') {
      const folded = [];
      index += 1;
      while (index < lines.length && /^\s+/.test(lines[index])) {
        folded.push(lines[index].trim());
        index += 1;
      }
      result[key] = rawValue === '>' ? folded.join(' ').trim() : folded.join('\n');
      continue;
    }

    if (rawValue === '') {
      const mapping = {};
      index += 1;
      while (index < lines.length && /^\s+/.test(lines[index])) {
        const child = lines[index].match(/^\s{2}([A-Za-z0-9_.-]+):\s*(.*)$/);
        if (!child) errors.push(`invalid ${key} mapping at frontmatter line ${index + 1}.`);
        else mapping[child[1]] = unquote(child[2]);
        index += 1;
      }
      result[key] = mapping;
      continue;
    }

    result[key] = unquote(rawValue);
    index += 1;
  }

  return result;
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
