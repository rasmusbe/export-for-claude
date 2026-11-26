// Step names and step-group summary lines.

import type { Block, ThinkingBlock, ToolUseBlock } from './types';

function basename(path: unknown): string {
  if (typeof path !== 'string' || !path) return '';
  return path.split('/').pop() || path;
}

/** `mcp__weather__get_state` → `{server: 'Weather', method: 'get_state'}`. */
export function parseMcpName(name: string): { server: string; method: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5);
  const sep = rest.indexOf('__');
  if (sep < 0) return null;
  const server = rest.slice(0, sep);
  const method = rest.slice(sep + 2);
  if (!server || !method) return null;
  return { server: server.charAt(0).toUpperCase() + server.slice(1), method };
}

const MEMORY_PREFIX = 'mcp__memory__';

/** Step line for a Cowork (Claude Code) tool call. */
export function coworkStepName(tool: ToolUseBlock): string {
  const name = tool.name || 'unknown';
  const input = (tool.input ?? {}) as Record<string, any>;

  if (name.startsWith(MEMORY_PREFIX)) {
    const op = name.slice(MEMORY_PREFIX.length);
    return input.path ? `${op} ${input.path}` : op;
  }
  const mcp = parseMcpName(name);
  if (mcp) return `${mcp.server}: ${mcp.method}`;

  switch (name) {
    case 'TaskCreate':
      return `Added task: ${input.subject ?? ''}`;
    case 'TaskUpdate':
      if (input.status === 'completed') return 'Completed task';
      if (input.status === 'in_progress') return 'Started task';
      return name;
    case 'Write':
      return `Created ${basename(input.file_path)}`;
    case 'Read':
      return `Read ${basename(input.file_path)}`;
    case 'Edit':
      return `Edited ${basename(input.file_path)}`;
    case 'SendUserFile':
      return 'Presented file(s)';
    case 'Bash':
      return input.description || 'Bash';
    case 'Projects':
      if (input.method === 'project_info') return 'Reading project info';
      if (input.method === 'project_search') return 'Searching project';
      break;
    case 'WebSearch':
      if (input.query) return `Searched: ${input.query}`;
      break;
    case 'WebFetch':
      if (input.url) return `Fetched: ${input.url}`;
      break;
    case 'ToolSearch':
      return 'Found tools';
  }
  if (name.startsWith('Task')) return name;
  return `Tool: ${name}`;
}

/** Step line for a chat tool call (the chat API supplies `message` labels). */
export function chatStepName(tool: ToolUseBlock): string {
  const input = (tool.input ?? {}) as Record<string, any>;
  if ((tool.name === 'web_search' || tool.name === 'web_fetch') && input.query) return input.query;
  if (tool.message) return tool.message;
  if (input.description) return input.description;
  if (input.query) return input.query;
  const mcp = parseMcpName(tool.name);
  if (mcp) return `${mcp.server}: ${mcp.method}`;
  return `Tool: ${tool.name}`;
}

const MEMORY_READ = new Set(['mcp__memory__memory_list', 'mcp__memory__memory_read']);
const MEMORY_WRITE = new Set(['mcp__memory__memory_write', 'mcp__memory__memory_append']);
const MEMORY_EDIT = new Set(['mcp__memory__memory_str_replace']);
const MEMORY_DELETE = new Set(['mcp__memory__memory_delete']);

const count = (n: number, one: string, many: (n: number) => string) => (n === 1 ? one : many(n));

/**
 * Cowork summary: "Used 2 tools, loaded tools, used Weather integration,
 * searched the web, read a file, ran 3 commands", first letter capitalised.
 */
export function coworkSummary(items: Block[]): string {
  let other = 0;
  let memRead = 0;
  let memWrite = 0;
  let memEdit = 0;
  let memDelete = 0;
  let read = 0;
  let created = 0;
  let edited = 0;
  let commands = 0;
  let tasks = false;
  let web = false;
  let loaded = false;
  let presented = false;
  const servers = new Set<string>();

  for (const b of items) {
    if (b.type !== 'tool_use') continue;
    const name = b.name || 'unknown';
    if (MEMORY_READ.has(name)) memRead++;
    else if (MEMORY_WRITE.has(name)) memWrite++;
    else if (MEMORY_EDIT.has(name)) memEdit++;
    else if (MEMORY_DELETE.has(name)) memDelete++;
    else if (name === 'Read') read++;
    else if (name === 'Write') created++;
    else if (name === 'Edit') edited++;
    else if (name === 'Bash') commands++;
    else if (name === 'WebSearch' || name === 'WebFetch') web = true;
    else if (name === 'ToolSearch' || name === 'ListConnectors') loaded = true;
    else if (name === 'SendUserFile') presented = true;
    else {
      const mcp = parseMcpName(name);
      if (mcp) servers.add(mcp.server);
      else if (name.startsWith('Task')) tasks = true;
      else other++;
    }
  }

  const parts: string[] = [];
  if (other) parts.push(count(other, 'used a tool', (n) => `used ${n} tools`));
  if (loaded) parts.push('loaded tools');
  for (const s of servers) parts.push(`used ${s} integration`);
  if (web) parts.push('searched the web');
  if (presented) parts.push('presented files');
  if (tasks) parts.push('updated tasks');
  if (read) parts.push(count(read, 'read a file', (n) => `read ${n} files`));
  if (created) parts.push(count(created, 'created a file', (n) => `created ${n} files`));
  if (edited) parts.push(count(edited, 'edited a file', (n) => `edited ${n} files`));
  if (commands) parts.push(count(commands, 'ran a command', (n) => `ran ${n} commands`));
  if (memRead) parts.push(count(memRead, 'read a memory', (n) => `read ${n} memories`));
  if (memWrite) parts.push(count(memWrite, 'created a memory', (n) => `created ${n} memories`));
  if (memEdit) parts.push(count(memEdit, 'edited a memory', (n) => `edited ${n} memories`));
  if (memDelete) parts.push(count(memDelete, 'deleted a memory', (n) => `deleted ${n} memories`));
  if (!parts.length) return '';
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type ChatToolLabel = { fixed: string } | { one: string; many: (n: number) => string };

const CHAT_TOOL_LABELS: Record<string, ChatToolLabel> = {
  view: { one: 'Viewed file', many: (n) => `Viewed ${n} files` },
  bash_tool: { one: 'Ran command', many: (n) => `Ran ${n} commands` },
  create_file: { one: 'Created file', many: (n) => `Created ${n} files` },
  str_replace: { one: 'Edited file', many: (n) => `Edited ${n} files` },
  web_fetch: { one: 'Fetched page', many: (n) => `Fetched ${n} pages` },
  present_files: { one: 'Presented file', many: (n) => `Presented ${n} files` },
  web_search: { fixed: 'Searched the web' },
  tool_search: { fixed: 'Searched tools' },
  repl: { fixed: 'Analyzed data' },
};

/**
 * Chat summary: the last thinking summary in the group, otherwise counts per
 * tool ("Searched the web, ran 2 commands").
 */
export function chatSummary(items: Block[]): string {
  const thinking = [...items].reverse().find((b): b is ThinkingBlock => b.type === 'thinking');
  if (thinking?.summary) return thinking.summary;

  const counts = new Map<string, number>();
  for (const b of items) if (b.type === 'tool_use') counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
  const parts: string[] = [];
  let other = 0;
  for (const [name, n] of counts) {
    const label = CHAT_TOOL_LABELS[name];
    if (!label) other += n;
    else if ('fixed' in label) parts.push(label.fixed);
    else parts.push(n === 1 ? label.one : label.many(n));
  }
  if (other) parts.push(other === 1 ? 'Used tool' : `Used ${other} tools`);
  if (!parts.length) return '';
  return [parts[0], ...parts.slice(1).map((p) => p.charAt(0).toLowerCase() + p.slice(1))].join(', ');
}
