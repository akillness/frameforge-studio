// Minimal JSON Schema (2020-12 subset) validator for agent operation inputs and outputs.
// Supported: type, enum, const, properties, required, additionalProperties, items, minItems,
// maxItems, minLength, maxLength, minimum, maximum, pattern, anyOf. Unknown keywords are ignored
// (annotations such as description/title/default). $ref is rejected: schemas here are self-contained.

const typeOf = (value) => value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
const matchesType = (value, type) => type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeOf(value) === type || (type === 'number' && typeOf(value) === 'integer');
const MAX_DEPTH = 24;

export function validateSchema(schema, value, path = '$', depth = 0) {
  const errors = [];
  if (depth > MAX_DEPTH) return [`${path}: schema nesting exceeds ${MAX_DEPTH}`];
  if (schema === true || schema === undefined) return errors;
  if (schema === false) return [`${path}: no value is allowed here`];
  if (schema.$ref !== undefined) return [`${path}: $ref is not supported`];
  if (schema.anyOf) {
    if (!schema.anyOf.some((option) => validateSchema(option, value, path, depth + 1).length === 0)) errors.push(`${path}: does not match any allowed shape`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) return [...errors, `${path}: expected ${types.join(' or ')}, received ${typeOf(value)}`];
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) errors.push(`${path}: must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`);
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: does not match pattern ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items !== undefined) for (let index = 0; index < value.length && errors.length < 20; index++) errors.push(...validateSchema(schema.items, value[index], `${path}[${index}]`, depth + 1));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) if (!Object.hasOwn(value, key) || value[key] === undefined) errors.push(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (Object.hasOwn(properties, key)) errors.push(...validateSchema(properties[key], item, `${path}.${key}`, depth + 1));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unknown field`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...validateSchema(schema.additionalProperties, item, `${path}.${key}`, depth + 1));
    }
  }
  return errors.slice(0, 20);
}
