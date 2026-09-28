import { createHash } from "node:crypto";
import type { JsonRecord, OmpTool, ToolNameRegistry, KiroToolSpecification } from "./types";

export const MAX_KIRO_TOOL_COUNT = 48;
export const MAX_KIRO_TOOL_CATALOG_BYTES = 96_000;
const DEFAULT_DESCRIPTION_LIMIT = 1_024;
const GPT_56_SOL_DESCRIPTION_LIMIT = 9_216;

const REJECTED_SCHEMA_KEYS = new Set([
  "additionalProperties",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "contentEncoding",
  "contentMediaType",
  "$schema",
  "patternProperties",
  "propertyNames",
  "dependentSchemas",
  "dependentRequired",
  "if",
  "then",
  "else",
  "contains",
  "unevaluatedProperties",
  "unevaluatedItems",
  "encrypted",
]);

const SCHEMA_MAP_KEYS = new Set(["properties", "$defs", "definitions"]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

export function toolParametersToJsonSchema(parameters: unknown): JsonRecord {
  if (typeof parameters === "function") {
    const candidate = parameters as unknown as {
      toJsonSchema?: (options?: unknown) => unknown;
    };
    if (typeof candidate.toJsonSchema === "function") {
      const raw = candidate.toJsonSchema({ target: "draft-2020-12", fallback: (ctx: any) => ctx?.base ?? {} });
      if (isRecord(raw)) {
        const cloned = cloneJson(raw);
        delete cloned.$schema;
        return cloned;
      }
    }
  }
  if (isRecord(parameters)) return cloneJson(parameters);
  return { type: "object", properties: {} };
}

function sanitizeSchemaMap(value: unknown): unknown {
  if (!isRecord(value)) return sanitizeKiroSchema(value);
  const out: JsonRecord = {};
  for (const [name, child] of Object.entries(value)) out[name] = sanitizeKiroSchema(child);
  return out;
}

export function sanitizeKiroSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeKiroSchema);
  if (!isRecord(value)) return value;
  const out: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) {
    if (REJECTED_SCHEMA_KEYS.has(key)) continue;
    if (key === "required" && Array.isArray(child) && child.length === 0) continue;
    out[key] = SCHEMA_MAP_KEYS.has(key) ? sanitizeSchemaMap(child) : sanitizeKiroSchema(child);
  }
  return out;
}

export function ensureKiroRootObject(schema: unknown): JsonRecord {
  const obj = isRecord(schema) ? schema : {};
  const composition = ["oneOf", "anyOf", "allOf"].filter(key => Array.isArray(obj[key]));
  if (composition.length === 0) {
    return obj.type === "object" ? obj : { ...obj, type: "object" };
  }
  const properties: JsonRecord = isRecord(obj.properties) ? { ...obj.properties } : {};
  const required = new Set<string>(Array.isArray(obj.required) ? obj.required.filter((v): v is string => typeof v === "string") : []);
  for (const key of composition) {
    const variants = obj[key] as unknown[];
    const mergeRequired = key === "allOf";
    for (const variant of variants) {
      if (!isRecord(variant)) continue;
      if (isRecord(variant.properties)) Object.assign(properties, variant.properties);
      if (mergeRequired && Array.isArray(variant.required)) {
        for (const item of variant.required) if (typeof item === "string") required.add(item);
      }
    }
  }
  const merged: JsonRecord = {};
  for (const [key, child] of Object.entries(obj)) {
    if (key === "oneOf" || key === "anyOf" || key === "allOf" || key === "type" || key === "properties" || key === "required") continue;
    merged[key] = child;
  }
  merged.type = "object";
  if (Object.keys(properties).length > 0) merged.properties = properties;
  if (required.size > 0) merged.required = [...required];
  return merged;
}

function hash8(value: string, salt = 0): string {
  const source = salt === 0 ? value : `${value}#${salt}`;
  return createHash("sha256").update(source).digest("hex").slice(0, 8);
}

export function createToolNameRegistry(): ToolNameRegistry {
  const used = new Set<string>();
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  return {
    alias(name: string): string {
      const existing = forward.get(name);
      if (existing) return existing;
      const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
      let alias: string;
      if (cleaned === name && cleaned.length >= 1 && cleaned.length <= 64 && !used.has(cleaned)) {
        alias = cleaned;
      } else {
        const base = (cleaned.slice(0, 55) || "tool");
        let salt = 0;
        do alias = `${base}_${hash8(name, salt++)}`; while (used.has(alias));
      }
      used.add(alias);
      forward.set(name, alias);
      if (alias !== name) reverse.set(alias, name);
      return alias;
    },
    restore(name: string): string {
      return reverse.get(name) ?? name;
    },
    nameMap: reverse,
  };
}

function descriptionLimit(modelId: string): number {
  const normalized = modelId.toLowerCase().replace(/^kiro\//, "");
  return normalized === "gpt-5.6-sol" ? GPT_56_SOL_DESCRIPTION_LIMIT : DEFAULT_DESCRIPTION_LIMIT;
}

function truncateDescription(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let end = limit - 1;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${value.slice(0, end)}…`;
}

export function buildKiroToolCatalog(
  tools: readonly OmpTool[],
  modelId: string,
  registry = createToolNameRegistry(),
  reserveNames: readonly string[] = [],
): { tools: KiroToolSpecification[]; omitted: string[]; registry: ToolNameRegistry } {
  const limit = descriptionLimit(modelId);
  const entries = tools.map((tool, index) => ({
    index,
    originalName: tool.name,
    converted: {
      toolSpecification: {
        name: registry.alias(tool.name),
        description: truncateDescription(tool.description || `Tool: ${tool.name}`, limit),
        inputSchema: {
          json: ensureKiroRootObject(sanitizeKiroSchema(toolParametersToJsonSchema(tool.parameters))),
        },
      },
    } satisfies KiroToolSpecification,
  }));
  const reserve = new Set(reserveNames);
  const candidates = entries.toSorted((a, b) => Number(reserve.has(b.originalName)) - Number(reserve.has(a.originalName)) || a.index - b.index);
  const accepted: typeof entries = [];
  for (const entry of candidates) {
    const projected = [...accepted, entry].map(item => item.converted);
    if (projected.length > MAX_KIRO_TOOL_COUNT) continue;
    if (new TextEncoder().encode(JSON.stringify(projected)).byteLength > MAX_KIRO_TOOL_CATALOG_BYTES) continue;
    accepted.push(entry);
  }
  accepted.sort((a, b) => a.index - b.index);
  const acceptedNames = new Set(accepted.map(item => item.originalName));
  return {
    tools: accepted.map(item => item.converted),
    omitted: entries.filter(item => !acceptedNames.has(item.originalName)).map(item => item.originalName),
    registry,
  };
}

export function assertKiroSchemaSafe(value: unknown, inSchemaMap = false): void {
  if (Array.isArray(value)) {
    for (const item of value) assertKiroSchemaSafe(item, false);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (!inSchemaMap && REJECTED_SCHEMA_KEYS.has(key)) throw new Error(`Kiro schema still contains rejected keyword ${key}`);
    if (SCHEMA_MAP_KEYS.has(key) && isRecord(child)) {
      for (const schema of Object.values(child)) assertKiroSchemaSafe(schema, false);
    } else {
      assertKiroSchemaSafe(child, false);
    }
  }
}
