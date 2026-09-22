export interface FreebuffSourceFile {
  content: string;
  revision: string;
}

export interface FreebuffCatalogSourceFiles {
  modelIds: FreebuffSourceFile;
  models: FreebuffSourceFile;
  agents: FreebuffSourceFile;
  modelConfig: FreebuffSourceFile;
  entitlements: FreebuffSourceFile;
}

export interface ParsedFreebuffModel {
  id: string;
  displayName: string;
  agentId: string;
  sourceRevision: string;
  surfaces: readonly ["base2"];
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  availability: "active";
}

export interface ParsedFreebuffCatalog {
  sourceRevision: string;
  models: ParsedFreebuffModel[];
  pausedModelIds: string[];
}

export class FreebuffCatalogParseError extends Error {
  readonly code = "FREEBUFF_CATALOG_PARSE_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "FreebuffCatalogParseError";
  }
}

type Primitive = string | number | boolean | string[] | undefined;
type ModelObject = {
  name: string;
  fields: Map<string, string>;
  values: Map<string, Primitive>;
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function fail(message: string): never {
  throw new FreebuffCatalogParseError(message);
}

function escapeRegExp(value: string): string {
  return value.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

function stripComments(source: string): string {
  let output = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (quote) {
      output += current;
      if (current === "\\" && next) {
        output += next;
        index += 1;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }
    if (current === "'" || current === '"') {
      quote = current;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      if (index < source.length) output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index + 1 < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") output += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }
    output += current;
  }
  return output;
}

function readBalanced(source: string, start: number): { body: string; end: number } {
  const open = source[start];
  const close = open === "{" ? "}" : open === "[" ? "]" : open === "(" ? ")" : "";
  if (!close) fail("Expected a supported literal at offset " + start);
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = start; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (quote) {
      if (current === "\\" && next) index += 1;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === "'" || current === '"') {
      quote = current;
      continue;
    }
    if (current === open) {
      depth += 1;
    } else if (current === close) {
      depth -= 1;
      if (depth === 0) return { body: source.slice(start + 1, index), end: index + 1 };
    }
  }
  fail("Unterminated literal");
}

function findDeclaration(source: string, name: string): { expression: string; end: number } {
  const pattern = new RegExp(
    "(?:export\\s+)?(?:const|let|var)\\s+" + escapeRegExp(name) + "\\s*(?::[^=;]+)?\\s*=",
    "m"
  );
  const match = pattern.exec(source);
  if (!match || match.index === undefined) fail("Missing declaration: " + name);
  let start = match.index + match[0].length;
  while (/\s/.test(source[start] ?? "")) start += 1;
  const opener = source[start];
  if (opener === "{" || opener === "[" || opener === "(") {
    const balanced = readBalanced(source, start);
    return {
      expression: opener + balanced.body + (opener === "{" ? "}" : opener === "[" ? "]" : ")"),
      end: balanced.end,
    };
  }
  let end = start;
  while (end < source.length && source[end] !== "\n" && source[end] !== ";") end += 1;
  return { expression: source.slice(start, end).trim(), end };
}

function unquote(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2) return undefined;
  const quote = trimmed[0];
  if ((quote !== "'" && quote !== '"') || trimmed[trimmed.length - 1] !== quote) return undefined;
  const body = trimmed.slice(1, -1);
  let result = "";
  for (let index = 0; index < body.length; index += 1) {
    const current = body[index];
    const next = body[index + 1];
    if (current !== "\\") {
      result += current;
      continue;
    }
    if (!next) fail("Invalid string escape");
    if (next === "n") result += "\n";
    else if (next === "r") result += "\r";
    else if (next === "t") result += "\t";
    else result += next;
    index += 1;
  }
  return result;
}

function splitTopLevel(body: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  let brace = 0;
  let bracket = 0;
  let paren = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < body.length; index += 1) {
    const current = body[index];
    const next = body[index + 1];
    if (quote) {
      if (current === "\\" && next) index += 1;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === "'" || current === '"') quote = current;
    else if (current === "{") brace += 1;
    else if (current === "}") brace -= 1;
    else if (current === "[") bracket += 1;
    else if (current === "]") bracket -= 1;
    else if (current === "(") paren += 1;
    else if (current === ")") paren -= 1;
    else if (current === "," && brace === 0 && bracket === 0 && paren === 0) {
      chunks.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  const final = body.slice(start).trim();
  if (final) chunks.push(final);
  return chunks;
}

function collectObjectFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const chunk of splitTopLevel(body)) {
    if (!chunk || chunk.startsWith("...")) continue;
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([\s\S]+)$/.exec(chunk);
    if (!match) continue;
    const key = match[1];
    const expression = match[2].trim();
    if (fields.has(key) && fields.get(key) !== expression)
      fail("Conflicting duplicate field: " + key);
    fields.set(key, expression);
  }
  return fields;
}

function collectObjectDeclarations(source: string): Map<string, Map<string, string>> {
  const declarations = new Map<string, Map<string, string>>();
  const pattern =
    /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;]+)?=\s*\{/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const start = (match.index ?? 0) + match[0].length - 1;
    const balanced = readBalanced(source, start);
    const fields = collectObjectFields(balanced.body);
    if (declarations.has(name)) {
      const previous = declarations.get(name)!;
      for (const [key, value] of fields) {
        if (previous.has(key) && previous.get(key) !== value)
          fail("Conflicting duplicate object declaration: " + name + "." + key);
        previous.set(key, value);
      }
    } else declarations.set(name, fields);
  }
  return declarations;
}

function collectRawConstants(sources: string[]): Map<string, string> {
  const raw = new Map<string, string>();
  for (const source of sources) {
    const pattern =
      /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;]+)?=\s*/g;
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      const start = (match.index ?? 0) + match[0].length;
      const rest = source.slice(start);
      const stringMatch = /^(['"][\s\S]*?['"])(?=\s*(?:;|\n|$))/.exec(rest);
      const referenceMatch =
        /^([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?)(?=\s*(?:;|\n|$))/.exec(rest);
      const expression = stringMatch?.[1] ?? referenceMatch?.[1];
      if (!expression) continue;
      const previous = raw.get(name);
      if (previous && previous !== expression) fail("Conflicting duplicate constant: " + name);
      raw.set(name, expression);
    }
  }
  return raw;
}

function resolveExpression(
  expression: string,
  constants: Map<string, string>,
  objectFields: Map<string, Map<string, string>>,
  stack: Set<string> = new Set()
): Primitive {
  const value = expression.trim().replace(/\s+as\s+const\s*$/, "");
  const quoted = unquote(value);
  if (quoted !== undefined) return quoted;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const objectMember = /^([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(value);
  if (objectMember) {
    const objectName = objectMember[1];
    const member = objectMember[2];
    const key = objectName + "." + member;
    const memberExpression = objectFields.get(objectName)?.get(member);
    if (memberExpression !== undefined) {
      if (stack.has(key)) fail("Cyclic constant: " + key);
      const next = new Set(stack);
      next.add(key);
      return resolveExpression(memberExpression, constants, objectFields, next);
    }
  }
  if (IDENTIFIER.test(value)) {
    const raw = constants.get(value);
    if (raw !== undefined) {
      if (stack.has(value)) fail("Cyclic constant: " + value);
      const next = new Set(stack);
      next.add(value);
      return resolveExpression(raw, constants, objectFields, next);
    }
  }
  return undefined;
}

function parseStringArray(
  expression: string,
  constants: Map<string, string>,
  objectFields: Map<string, Map<string, string>>
): string[] | undefined {
  const value = expression.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) return undefined;
  const balanced = readBalanced(value, 0);
  const entries: string[] = [];
  for (const chunk of splitTopLevel(balanced.body)) {
    if (!chunk || chunk.startsWith("...")) return undefined;
    const parsed = resolveExpression(chunk, constants, objectFields);
    if (typeof parsed !== "string") return undefined;
    entries.push(parsed);
  }
  return entries;
}

function collectModelObjects(
  source: string,
  constants: Map<string, string>,
  objectFields: Map<string, Map<string, string>>
): Map<string, ModelObject> {
  const objects = new Map<string, ModelObject>();
  const pattern =
    /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;]+)?=\s*\{/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (!name.endsWith("_MODEL")) continue;
    const start = (match.index ?? 0) + match[0].length - 1;
    const balanced = readBalanced(source, start);
    const fields = collectObjectFields(balanced.body);
    const values = new Map<string, Primitive>();
    for (const [key, expression] of fields) {
      const array = parseStringArray(expression, constants, objectFields);
      values.set(key, array ?? resolveExpression(expression, constants, objectFields));
    }
    if (objects.has(name)) fail("Duplicate model object: " + name);
    objects.set(name, { name, fields, values });
  }
  return objects;
}

function extractArrayBody(source: string, name: string): string {
  const expression = findDeclaration(source, name).expression.trim();
  if (!expression.startsWith("[") || !expression.endsWith("]"))
    fail("Expected array declaration: " + name);
  return readBalanced(expression, 0).body;
}

function collectBooleanConstants(sources: string[]): Map<string, boolean> {
  const values = new Map<string, boolean>();
  for (const source of sources) {
    const pattern = /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(true|false)\b/g;
    for (const match of source.matchAll(pattern)) {
      const value = match[2] === "true";
      const previous = values.get(match[1]);
      if (previous !== undefined && previous !== value) {
        fail("Conflicting boolean constant: " + match[1]);
      }
      values.set(match[1], value);
    }
  }
  return values;
}

function addModelNames(body: string, names: Set<string>): void {
  for (const match of body.matchAll(/\b([A-Z][A-Z0-9_]*_MODEL)\b/g)) {
    names.add(match[1]);
  }
}

function extractModelObjectNames(
  source: string,
  name: string,
  booleanConstants: Map<string, boolean>
): string[] {
  const body = extractArrayBody(source, name);
  const names = new Set<string>();
  for (const chunk of splitTopLevel(body)) {
    if (!chunk) continue;
    if (!chunk.startsWith("...")) {
      addModelNames(chunk, names);
      continue;
    }
    const conditional =
      /^\.\.\.\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\?\s*\[([\s\S]*?)\]\s*:\s*\[\s*\]\s*\)$/.exec(
        chunk
      );
    if (conditional) {
      const enabled = booleanConstants.get(conditional[1]);
      if (enabled === undefined) {
        fail("Unsupported surface eligibility condition: " + conditional[1]);
      }
      if (enabled) addModelNames(conditional[2], names);
      continue;
    }
    const spreadArray = /^\.\.\.\s*\[([\s\S]*)\]$/.exec(chunk);
    if (spreadArray) {
      addModelNames(spreadArray[1], names);
      continue;
    }
    fail("Unsupported surface eligibility expression");
  }
  return [...names];
}

function extractModelIdNames(source: string, name: string): string[] {
  const body = extractArrayBody(source, name);
  const names = new Set<string>();
  for (const match of body.matchAll(/\b([A-Z][A-Z0-9_]*_MODEL_ID)\b/g)) names.add(match[1]);
  return [...names];
}

function extractRootAgentMap(
  source: string,
  constants: Map<string, string>,
  objectFields: Map<string, Map<string, string>>
): Map<string, string> {
  const expression = findDeclaration(source, "FREEBUFF_ROOT_AGENT_ID_BY_MODEL").expression.trim();
  if (!expression.startsWith("{") || !expression.endsWith("}")) fail("Expected root agent object");
  const entries = new Map<string, string>();
  for (const chunk of splitTopLevel(readBalanced(expression, 0).body)) {
    if (!chunk || chunk.startsWith("...")) continue;
    const match = /^\[\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\]\s*:\s*([\s\S]+)$/.exec(chunk);
    if (!match) fail("Unsupported root-agent map entry");
    const modelId = resolveExpression(match[1], constants, objectFields);
    const agentId = resolveExpression(match[2], constants, objectFields);
    if (typeof modelId !== "string" || typeof agentId !== "string" || !agentId)
      fail("Unresolved root-agent map entry: " + match[1]);
    if (entries.has(modelId) && entries.get(modelId) !== agentId)
      fail("Conflicting root-agent mapping for " + modelId);
    entries.set(modelId, agentId);
  }
  return entries;
}

function resolveArrayIds(
  source: string,
  name: string,
  constants: Map<string, string>,
  objectFields: Map<string, Map<string, string>>
): string[] {
  return extractModelIdNames(source, name).map((constantName) => {
    const value = resolveExpression(constantName, constants, objectFields);
    if (typeof value !== "string") fail("Unresolved model id in " + name + ": " + constantName);
    return value;
  });
}

export function parseFreebuffCatalog(files: FreebuffCatalogSourceFiles): ParsedFreebuffCatalog {
  const revisions = Object.values(files).map((file) => file.revision);
  if (revisions.some((revision) => revision !== revisions[0]))
    fail("Mixed source revisions are not allowed");
  const sourceRevision = revisions[0];
  if (!sourceRevision) fail("Missing source revision");

  const sources = Object.values(files).map((file) => stripComments(file.content));
  const constants = collectRawConstants(sources);
  const objectFields = new Map<string, Map<string, string>>();
  for (const source of sources) {
    for (const [name, fields] of collectObjectDeclarations(source)) {
      if (objectFields.has(name)) {
        const previous = objectFields.get(name)!;
        for (const [key, value] of fields) {
          if (previous.has(key) && previous.get(key) !== value)
            fail("Conflicting object member: " + name + "." + key);
          previous.set(key, value);
        }
      } else objectFields.set(name, fields);
    }
  }

  const modelObjects = collectModelObjects(
    stripComments(files.models.content),
    constants,
    objectFields
  );
  const cleanModels = stripComments(files.models.content);
  const booleanConstants = collectBooleanConstants(sources);
  const offeredNames = extractModelObjectNames(cleanModels, "FREEBUFF_MODELS", booleanConstants);
  const pausedIds = new Set(
    resolveArrayIds(cleanModels, "FREEBUFF_PAUSED_FREE_MODEL_IDS", constants, objectFields)
  );
  const rootAgentMap = extractRootAgentMap(
    stripComments(files.agents.content),
    constants,
    objectFields
  );

  const models: ParsedFreebuffModel[] = [];
  const seen = new Map<string, ParsedFreebuffModel>();
  for (const objectName of offeredNames) {
    const object = modelObjects.get(objectName);
    if (!object) fail("Offered model object is missing: " + objectName);
    const id = object.values.get("id");
    const displayName = object.values.get("displayName");
    if (typeof id !== "string" || !id) fail("Offered model has no supported id: " + objectName);
    if (typeof displayName !== "string" || !displayName)
      fail("Offered model has no display name: " + objectName);
    if (pausedIds.has(id)) continue;
    const agentId = rootAgentMap.get(id);
    if (!agentId) fail("Offered model has no base2 root mapping: " + id);

    const fields = object.fields;
    const model: ParsedFreebuffModel = {
      id,
      displayName,
      agentId,
      sourceRevision,
      surfaces: ["base2"],
      availability: "active",
      ...(fields.has("reasoningEffort") || fields.has("efforts") || fields.has("defaultEffort")
        ? { supportsReasoning: true }
        : {}),
      ...(typeof object.values.get("multimodal") === "boolean"
        ? { supportsVision: object.values.get("multimodal") as boolean }
        : {}),
    };
    const previous = seen.get(id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(model))
      fail("Conflicting duplicate offered model: " + id);
    if (!previous) {
      seen.set(id, model);
      models.push(model);
    }
  }

  return { sourceRevision, models, pausedModelIds: [...pausedIds] };
}
