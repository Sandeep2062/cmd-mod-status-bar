import https from 'https';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

function formatDuration(ms) {
  if (typeof ms !== 'number' || isNaN(ms) || ms <= 0) return '0m';
  const totalMinutes = Math.max(1, Math.ceil(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const mins = totalMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${mins}m`;
}

function formatContextTokenCount(e) {
  if (typeof e !== 'number' || isNaN(e) || e <= 0) return '0k';
  if (e < 1000) return String(e);
  if (e >= 1000000) {
    const n = Math.round(e / 100000) / 10;
    return Number.isInteger(n) ? `${n.toFixed(0)}M` : `${n.toFixed(1)}M`;
  }
  const n = Math.round(e / 100) / 10;
  return Number.isInteger(n) ? `${n.toFixed(0)}k` : `${n.toFixed(1)}k`;
}

function formatTokens(tokens, limit = 1000000) {
  if (typeof tokens !== 'number' || isNaN(tokens) || tokens <= 0) return 'ctx 0k/1M · 0%';
  const kTokens = formatContextTokenCount(tokens);
  const maxLimit = (typeof limit === 'number' && limit > 0) ? limit : 1000000;
  const pct = Math.round((tokens / maxLimit) * 100);
  const limitStr = formatContextTokenCount(maxLimit);
  return `ctx ${kTokens}/${limitStr} · ${pct}%`;
}

function findRepoInfo(startDir = process.cwd()) {
  let curr = path.resolve(startDir);
  let repoName = path.basename(curr);
  let branch = null;

  while (curr) {
    const gitHead = path.join(curr, '.git', 'HEAD');
    if (fs.existsSync(gitHead)) {
      repoName = path.basename(curr);
      try {
        const content = fs.readFileSync(gitHead, 'utf8').trim();
        if (content.startsWith('ref: refs/heads/')) {
          branch = content.replace('ref: refs/heads/', '');
        } else if (content.length >= 7) {
          branch = content.substring(0, 7);
        }
      } catch {}
      break;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }

  return { repoName, branch };
}

function getTabTitle(repoName, cwd) {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const registryFile = path.join(home, '.commandcode', 'active_tabs.json');
    let instances = [];
    if (fs.existsSync(registryFile)) {
      try {
        instances = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      } catch {}
    }

    const currentPid = process.pid;
    const alive = instances.filter(inst => {
      if (inst.pid === currentPid) return true;
      try {
        process.kill(inst.pid, 0);
        return true;
      } catch {
        return false;
      }
    });

    let self = alive.find(inst => inst.pid === currentPid);
    if (!self) {
      self = { pid: currentPid, repo: repoName, cwd: path.resolve(cwd), startTime: Date.now() };
      alive.push(self);
    } else {
      self.repo = repoName;
      self.cwd = path.resolve(cwd);
    }

    try {
      fs.writeFileSync(registryFile, JSON.stringify(alive, null, 2), 'utf8');
    } catch {}

    const sameRepo = alive
      .filter(inst => inst.repo.toLowerCase() === repoName.toLowerCase())
      .sort((a, b) => a.startTime - b.startTime);

    const index = sameRepo.findIndex(inst => inst.pid === currentPid);
    const num = index >= 0 ? index + 1 : 1;

    return num === 1 ? repoName : `${repoName} (${num})`;
  } catch {
    return repoName;
  }
}

function cleanupInstance() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const registryFile = path.join(home, '.commandcode', 'active_tabs.json');
    if (fs.existsSync(registryFile)) {
      const instances = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      const alive = instances.filter(inst => inst.pid !== process.pid);
      fs.writeFileSync(registryFile, JSON.stringify(alive, null, 2), 'utf8');
    }
  } catch {}
}

const TOKEN_CHAR_RATIO = 3.5;
const JSON_RATIO = 1.1;
// Measured against the /context rows for Command Code's 22 built-in tools
// (12.6k) and the loaded skill manifest (4.4k).
const BUILTIN_TOOLS_TOKENS = 12600;
const SKILLS_TOKENS = 4400;
const SYSTEM_TOOLS_AND_SKILLS = BUILTIN_TOOLS_TOKENS + SKILLS_TOKENS;

function estimateTextTokens(str) {
  if (!str) return 0;
  const s = typeof str === 'string' ? str : String(str);
  const n = s.length / TOKEN_CHAR_RATIO;
  const o = 0.1 * s.split(/\s+/).length;
  return Math.max(0, Math.ceil(n - o));
}

function estimateImageTokens(source) {
  try {
    if (!source) return 1229;
    const buf = Buffer.from(String(source), 'base64');
    if (buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
      return Math.ceil((buf.readUInt32BE(16) * buf.readUInt32BE(20)) / 750);
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      for (let i = 2; i < buf.length - 10; i++) {
        if (buf[i] === 0xff && (buf[i + 1] === 0xc0 || buf[i + 1] === 0xc2)) {
          return Math.ceil((buf.readUInt16BE(i + 7) * buf.readUInt16BE(i + 5)) / 750);
        }
      }
    }
  } catch {}
  return 1229;
}

function estimateTokens3(e) {
  if (!e) return 0;
  if (typeof e === 'string') {
    let n = estimateTextTokens(e);
    if (e.startsWith('{') || e.startsWith('[')) n = Math.ceil(n * JSON_RATIO);
    return n;
  }
  return estimateMessageForContext(e);
}

// Mirrors Command Code's toV2 + estimateTokens3: tool results keep only their
// text (images inside them are dropped before estimation) and top-level images
// are sized by their dimensions rather than by base64 length.
function estimateMessageForContext(m) {
  if (!m) return 0;
  const content = typeof m.content === 'string'
    ? [{ type: 'text', text: m.content }]
    : (Array.isArray(m.content) ? m.content : []);
  let n = 0;

  if (m.role === 'assistant') {
    n = 3;
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        n += estimateTextTokens(b.text);
      } else if (b.type === 'tool-call' || b.type === 'tool_use') {
        n += 5;
        const name = b.toolName || b.name;
        if (name) n += estimateTextTokens(name);
        const input = b.input || b.arguments;
        if (input) n += Math.ceil(estimateTextTokens(JSON.stringify(input)) * JSON_RATIO);
      }
    }
    return Math.ceil(n);
  }

  let hasTool = false;
  let hasUser = false;
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'tool-result' || b.type === 'tool_result') {
      hasTool = true;
      n += 3;
      const out = b.output;
      if (out && typeof out === 'object' && typeof out.value === 'string') {
        n += estimateTextTokens(out.value);
      } else if (typeof b.content === 'string') {
        n += estimateTextTokens(b.content);
      } else if (Array.isArray(b.content)) {
        let text = '';
        for (const c of b.content) {
          if (c && c.type === 'text' && typeof c.text === 'string') {
            text += (text ? '\n' : '') + c.text;
          }
        }
        n += estimateTextTokens(text);
      }
    } else if (b.type === 'text' && typeof b.text === 'string') {
      hasUser = true;
      n += estimateTextTokens(b.text);
    } else if (b.type === 'image') {
      hasUser = true;
      const src = b.image || (b.source && b.source.data) || '';
      n += estimateImageTokens(String(src).replace(/^data:[^;]+;base64,/, ''));
    }
  }
  if (hasTool) n += 3;
  if (hasUser) n += 3;
  return Math.ceil(n);
}

function stripThinking(messages) {
  const res = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role !== 'assistant') {
      res.push(m);
      continue;
    }
    if (Array.isArray(m.content)) {
      const filtered = m.content.filter(b => b && b.type !== 'thinking');
      if (filtered.length > 0) {
        res.push({ ...m, content: filtered });
      }
    } else {
      res.push(m);
    }
  }
  return res;
}

function entryToContextMessages(e) {
  if (!e) return [];
  if (e.type === 'message' && e.message) return [e.message];
  if (e.type === 'compaction') {
    return [{
      role: 'user',
      content: [{ type: 'text', text: e.summary || '' }],
      meta: { isSummary: true, summaryEntryId: e.id }
    }];
  }
  return [];
}

const storeDirCache = new Map();

function hostProjectDirName(projectPath) {
  const decamelized = projectPath
    .replace(/([A-Z]{2,})(\d+)/g, '$1 $2')
    .replace(/([a-z\d]+)([A-Z]{2,})/g, '$1 $2')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-rt-z\d]+)/g, '$1 $2');
  return decamelized
    .toLowerCase()
    .replace(/[^a-z\d]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '') || 'root';
}

function findStoreDirByCwd(baseDir, targetCwd) {
  let names;
  try {
    names = fs.readdirSync(baseDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return null;
  }

  const target = targetCwd.toLowerCase();
  for (const name of names) {
    const dir = path.join(baseDir, name);
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !f.includes('checkpoint'));
    } catch {
      continue;
    }
    for (const file of files.slice(0, 2)) {
      let fd;
      try {
        const filePath = path.join(dir, file);
        fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(2048);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        const firstLine = buf.toString('utf8', 0, read).split('\n', 1)[0];
        const head = JSON.parse(firstLine);
        if (head && head.type === 'session' && typeof head.cwd === 'string' &&
            path.resolve(head.cwd).toLowerCase() === target) {
          return dir;
        }
      } catch {} finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch {}
        }
      }
    }
  }
  return null;
}

function getProjectStoreDir(workingDir) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const baseDir = path.join(home, '.commandcode', 'projects');
  const norm = path.resolve(workingDir);
  const cacheKey = norm.toLowerCase();
  const now = Date.now();

  const cached = storeDirCache.get(cacheKey);
  if (cached && (cached.dir || now - cached.at < 30000)) {
    return cached.dir || path.join(baseDir, hostProjectDirName(norm));
  }

  const expected = path.join(baseDir, hostProjectDirName(norm));
  const dir = fs.existsSync(expected) ? expected : findStoreDirByCwd(baseDir, norm);
  storeDirCache.set(cacheKey, { dir, at: now });
  return dir || expected;
}

function listSessionFiles(projectStore) {
  return fs.readdirSync(projectStore)
    .filter(f => f.endsWith('.jsonl') && !f.includes('checkpoint'))
    .map(f => {
      const filePath = path.join(projectStore, f);
      return { name: f, path: filePath, mtime: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function reconstructContextEntries(pathEntries) {
  let compactionIdx = -1;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    if (pathEntries[i].type === 'compaction') {
      compactionIdx = i;
      break;
    }
  }

  if (compactionIdx === -1) {
    return { keptEntries: pathEntries, stripIds: null, hasCompaction: false };
  }

  const comp = pathEntries[compactionIdx];
  const keptEntries = [comp];
  let foundFirst = false;
  for (let i = 0; i < compactionIdx; i++) {
    const e = pathEntries[i];
    if (!foundFirst) {
      if (e.id !== comp.firstKeptEntryId) continue;
      foundFirst = true;
    }
    keptEntries.push(e);
  }
  for (let i = compactionIdx + 1; i < pathEntries.length; i++) keptEntries.push(pathEntries[i]);

  const stripIds = new Set(pathEntries.slice(0, compactionIdx).map(e => e.id));
  return { keptEntries, stripIds, hasCompaction: true };
}

function estimateConversationTokens(keptEntries, stripIds) {
  let tokens = 0;
  for (const e of keptEntries) {
    let msgs = entryToContextMessages(e);
    if (stripIds && stripIds.has(e.id)) msgs = stripThinking(msgs);
    for (const m of msgs) {
      if (m && !m.meta?.isMeta) tokens += estimateTokens3(m);
    }
  }
  return tokens;
}

function getMemoryFiles(workingDir) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const root = path.resolve(workingDir);
  const files = [];

  if (process.platform === 'win32') {
    files.push('C:\\ProgramData\\CommandCode\\AGENTS.md');
  } else if (process.platform === 'darwin') {
    files.push('/Library/Application Support/CommandCode/AGENTS.md');
  } else {
    files.push('/etc/.commandcode/AGENTS.md');
  }

  const projectFile = [path.join(root, 'AGENTS.md'), path.join(root, '.commandcode', 'AGENTS.md')]
    .find(p => {
      try { return fs.statSync(p).isFile(); } catch { return false; }
    });
  if (projectFile) files.push(projectFile);
  files.push(path.join(home, '.commandcode', 'AGENTS.md'));

  return files.filter(p => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
}

function estimateMemoryTokens(files) {
  let tokens = 0;
  for (const file of files) {
    try {
      tokens += estimateTokens3(fs.readFileSync(file, 'utf8'));
    } catch {}
  }
  return tokens;
}

function getMemorySignature(files) {
  return files.map(p => {
    try { return fs.statSync(p).mtimeMs; } catch { return 0; }
  }).join(':');
}

function getLatestContextUsage(workingDir = process.cwd(), liveSessionId = null, memoryFiles = null) {
  try {
    const projectStore = getProjectStoreDir(workingDir);
    if (!fs.existsSync(projectStore)) return null;

    const files = listSessionFiles(projectStore);
    if (files.length === 0) return null;

    const target = (liveSessionId && files.find(f => f.name === `${liveSessionId}.jsonl`)) || files[0];
    const lines = fs.readFileSync(target.path, 'utf8').trim().split('\n');
    if (lines.length === 0) return null;

    const entries = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {}
    }
    if (entries.length === 0) return null;

    const entriesMap = new Map(entries.map(e => [e.id, e]));
    const lastId = entries[entries.length - 1].id;

    const pathEntries = [];
    const seen = new Set();
    let curr = entriesMap.get(lastId);
    while (curr && !seen.has(curr.id)) {
      seen.add(curr.id);
      pathEntries.push(curr);
      curr = curr.parentId ? entriesMap.get(curr.parentId) : undefined;
    }
    pathEntries.reverse();

    const { keptEntries, stripIds, hasCompaction } = reconstructContextEntries(pathEntries);

    // Mirrors Command Code's /context breakdown: estimated messages, memory
    // files, and the built-in tools + loaded skills baseline.
    const messagesTokens = estimateConversationTokens(keptEntries, stripIds);
    const memoryTokens = estimateMemoryTokens(memoryFiles || getMemoryFiles(workingDir));
    const tokens = messagesTokens + memoryTokens + SYSTEM_TOOLS_AND_SKILLS;

    // Sanity anchor: a real session can never exceed its own context window,
    // so keep the last recorded API input size to fall back on.
    let realTokens = 0;
    for (let i = keptEntries.length - 1; i >= (hasCompaction ? 1 : 0); i--) {
      const usage = keptEntries[i].usage;
      if (usage && typeof usage.inputTokens === 'number' && usage.inputTokens > 0) {
        realTokens = usage.inputTokens;
        break;
      }
    }

    return { tokens, realTokens, file: target.name, mtime: target.mtime };
  } catch {}
  return null;
}

function fetchUsage(authKey) {
  return new Promise((resolve) => {
    if (!authKey) return resolve(null);
    const req = https.request({
      hostname: 'api.commandcode.ai',
      path: '/alpha/billing/credits',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${authKey}`,
        'Accept': 'application/json'
      },
      timeout: 3000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function getAuthKey() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const authFile = path.join(home, '.commandcode', 'auth.json');
    if (fs.existsSync(authFile)) {
      const data = JSON.parse(fs.readFileSync(authFile, 'utf8'));
      return data.apiKey || null;
    }
  } catch {}
  return null;
}

class StayAwakeManager {
  constructor() {
    this.proc = null;
    this.activeRuns = 0;
  }

  acquire() {
    this.activeRuns++;
    if (this.proc) return;

    try {
      if (process.platform === 'win32') {
        const psScript = `
$def = @"
[DllImport("kernel32.dll", SetLastError = true)]
public static extern int SetThreadExecutionState(int esFlags);
"@
$w = Add-Type -MemberDefinition $def -Name "WinAwakeRunner" -Namespace "Win32" -PassThru
$w::SetThreadExecutionState([int]0x80000003) | Out-Null
while ($true) {
  Start-Sleep -Seconds 30
  $w::SetThreadExecutionState([int]0x80000003) | Out-Null
}
`;
        this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
          windowsHide: true,
          stdio: 'ignore'
        });
        if (typeof this.proc.unref === 'function') this.proc.unref();
      } else if (process.platform === 'darwin') {
        this.proc = spawn('caffeinate', ['-d', '-i'], { stdio: 'ignore' });
        if (typeof this.proc.unref === 'function') this.proc.unref();
      } else if (process.platform === 'linux') {
        this.proc = spawn('systemd-inhibit', ['--what=idle:sleep', '--why=CommandCode running', 'sleep', 'infinity'], { stdio: 'ignore' });
        if (typeof this.proc.unref === 'function') this.proc.unref();
      }
    } catch {}
  }

  release() {
    this.activeRuns = Math.max(0, this.activeRuns - 1);
    if (this.activeRuns === 0 && this.proc) {
      try {
        this.proc.kill('SIGKILL');
      } catch {}
      this.proc = null;
    }
  }

  forceRelease() {
    this.activeRuns = 0;
    if (this.proc) {
      try {
        this.proc.kill('SIGKILL');
      } catch {}
      this.proc = null;
    }
  }
}

const stayAwake = new StayAwakeManager();

try {
  process.on('exit', () => {
    cleanupInstance();
    stayAwake.forceRelease();
  });
  process.on('SIGINT', () => {
    cleanupInstance();
    stayAwake.forceRelease();
  });
  process.on('SIGTERM', () => {
    cleanupInstance();
    stayAwake.forceRelease();
  });
} catch {}

export default function statusBarMod(cmd) {
  const authKey = getAuthKey();
  let diskCache = null;
  let lastKnownLimit = 1000000;
  let lastMtime = 0;
  let activeModel = null;
  let checkTimer = null;
  let billingTimer = null;

  const limits = {
    fiveHour: { pct: 0, resetAt: null },
    weekly: { pct: 0, resetAt: null }
  };

  function updateLimitsStrings(detailed = false) {
    const now = Date.now();
    let fhStr = `5h: ${limits.fiveHour.pct}%`;
    if (limits.fiveHour.resetAt && limits.fiveHour.resetAt > now) {
      const dur = formatDuration(limits.fiveHour.resetAt - now);
      fhStr += detailed ? ` (resets in ${dur})` : ` (${dur})`;
    }
    let wkStr = `wk: ${limits.weekly.pct}%`;
    if (limits.weekly.resetAt && limits.weekly.resetAt > now) {
      const dur = formatDuration(limits.weekly.resetAt - now);
      wkStr += detailed ? ` (resets in ${dur})` : ` (${dur})`;
    }
    return { fhStr, wkStr };
  }

  function applyTabTitle() {
    try {
      const workingDir = cmd.cwd || process.cwd();
      const { repoName } = findRepoInfo(workingDir);
      const title = getTabTitle(repoName, workingDir);
      if (cmd.ui && typeof cmd.ui.setTitle === 'function') {
        cmd.ui.setTitle(title);
      }
      if (process.stderr && process.stderr.isTTY) {
        process.stderr.write(`\x1b]0;${title}\x07\x1b]2;${title}\x07`);
      }
    } catch {}
  }

  async function refreshUsage() {
    const res = await fetchUsage(authKey);
    if (res && res.windowLimits) {
      const fh = res.windowLimits.fiveHour;
      if (fh && typeof fh.cap === 'number' && fh.cap > 0) {
        limits.fiveHour.pct = Math.round((fh.used / fh.cap) * 100);
        limits.fiveHour.resetAt = fh.resetAt || null;
      }
      const wk = res.windowLimits.weekly;
      if (wk && typeof wk.cap === 'number' && wk.cap > 0) {
        limits.weekly.pct = Math.round((wk.used / wk.cap) * 100);
        limits.weekly.resetAt = wk.resetAt || null;
      }
      if (cmd.ui && typeof cmd.ui.refreshWidgets === 'function') {
        cmd.ui.refreshWidgets();
      }
    }
  }

  function getLiveSessionId() {
    try {
      const session = cmd.session;
      if (session && typeof session.id === 'string' && session.id) return session.id;
    } catch {}
    return null;
  }

  function readHostContextUsage() {
    try {
      if (typeof cmd.getContextUsage !== 'function') return null;
      const cu = cmd.getContextUsage();
      if (!cu) return null;
      const limit = (typeof cu.contextWindow === 'number' && cu.contextWindow > 0)
        ? cu.contextWindow
        : (typeof cu.contextLimit === 'number' && cu.contextLimit > 0 ? cu.contextLimit : null);
      if (limit) lastKnownLimit = limit;
      if (typeof cu.tokens !== 'number' || cu.tokens <= 0) return null;
      return { tokens: cu.tokens, limit: limit || lastKnownLimit };
    } catch {}
    return null;
  }

  function getDiskContextUsage(workingDir) {
    try {
      const projectStore = getProjectStoreDir(workingDir);
      if (!fs.existsSync(projectStore)) return null;
      const files = listSessionFiles(projectStore);
      if (files.length === 0) return null;

      const liveSessionId = getLiveSessionId();
      const target = (liveSessionId && files.find(f => f.name === `${liveSessionId}.jsonl`)) || files[0];
      const memoryFiles = getMemoryFiles(workingDir);
      const memorySig = getMemorySignature(memoryFiles);
      if (diskCache && diskCache.file === target.name && diskCache.mtime === target.mtime &&
          diskCache.memorySig === memorySig) {
        return diskCache.value;
      }

      const value = getLatestContextUsage(workingDir, liveSessionId, memoryFiles);
      diskCache = { file: target.name, mtime: target.mtime, memorySig, value };
      return value;
    } catch {}
    return null;
  }

  function getActiveContextUsage(workingDir) {
    const host = readHostContextUsage();
    const limit = (host && host.limit) || lastKnownLimit;

    const disk = getDiskContextUsage(workingDir);
    if (disk) {
      const tokens = (disk.tokens > limit * 1.05 && disk.realTokens > 0)
        ? disk.realTokens
        : disk.tokens;
      return formatTokens(tokens, limit);
    }

    const tokens = estimateMemoryTokens(getMemoryFiles(workingDir)) + SYSTEM_TOOLS_AND_SKILLS;
    return formatTokens(tokens, limit);
  }

  function getModelDisplay() {
    let m = null;
    try {
      if (typeof cmd.getModel === 'function') m = cmd.getModel();
    } catch {}
    if (!m && activeModel) m = activeModel;
    if (!m) m = 'deepseek-v4.1-flash';

    if (typeof m === 'string' && m.includes('/')) {
      m = m.split('/').pop();
    }

    let eff = null;
    try {
      if (typeof cmd.getEffort === 'function') eff = cmd.getEffort();
    } catch {}

    return eff ? `${m} (${eff})` : m;
  }

  function pollContextAndTitle() {
    try {
      applyTabTitle();
      const workingDir = cmd.cwd || process.cwd();
      const projectStore = getProjectStoreDir(workingDir);
      if (fs.existsSync(projectStore)) {
        const files = listSessionFiles(projectStore);
        if (files.length > 0 && files[0].mtime !== lastMtime) {
          lastMtime = files[0].mtime;
          diskCache = null;
          getDiskContextUsage(workingDir);
          if (cmd.ui && typeof cmd.ui.refreshWidgets === 'function') {
            cmd.ui.refreshWidgets();
          }
        }
      }
    } catch {}
  }

  function teardown() {
    stayAwake.forceRelease();
    if (checkTimer) clearInterval(checkTimer);
    if (billingTimer) clearInterval(billingTimer);
    cleanupInstance();
  }

  if (cmd.ui && typeof cmd.ui.widget === 'function') {
    cmd.ui.widget({
      placement: 'below-editor',
      render(surface) {
        const termWidth = (typeof surface === 'object' && surface !== null && typeof surface.width === 'number')
          ? surface.width
          : (process.stdout.columns || 100);

        const workingDir = cmd.cwd || process.cwd();
        const { repoName, branch } = findRepoInfo(workingDir);
        const ctxUsage = getActiveContextUsage(workingDir);

        const branchPart = branch ? ` (${branch})` : '';
        const partProject = `${repoName}${branchPart}`;
        const partModel = getModelDisplay();

        const detailed = termWidth >= 120;
        const { fhStr, wkStr } = updateLimitsStrings(detailed);
        const limitsCombined = `${fhStr} · ${wkStr}`;

        const partsRight = [ctxUsage, limitsCombined].filter(Boolean).join(' · ');

        const singleLine = `${partProject} · ${partModel} · ${partsRight}`;
        if (singleLine.length <= termWidth - 4) {
          return [singleLine];
        }

        const compactLimits = updateLimitsStrings(false);
        const compactRight = [ctxUsage, `${compactLimits.fhStr} · ${compactLimits.wkStr}`].filter(Boolean).join(' · ');
        const line1 = `${partProject} · ${partModel}`;
        const line2 = (partsRight.length <= termWidth - 4) ? partsRight : compactRight;

        if (line1.length <= termWidth - 4 && line2.length <= termWidth - 4) {
          return [line1, line2];
        }

        return [
          partProject,
          partModel,
          line2
        ];
      }
    });
  }

  applyTabTitle();
  refreshUsage();

  if (typeof cmd.on === 'function') {
    cmd.on('run_start', () => {
      stayAwake.acquire();
      applyTabTitle();
    });

    cmd.on('turn_start', () => {
      stayAwake.acquire();
      applyTabTitle();
    });

    cmd.on('turn_end', () => {
      pollContextAndTitle();
    });

    cmd.on('run_end', () => {
      stayAwake.release();
      applyTabTitle();
      pollContextAndTitle();
      refreshUsage();
    });

    cmd.on('model_request_start', (evt) => {
      if (evt && evt.model) {
        activeModel = evt.model;
        if (cmd.ui && typeof cmd.ui.refreshWidgets === 'function') {
          cmd.ui.refreshWidgets();
        }
      }
    });

    cmd.on('compaction_outcome', () => {
      try {
        diskCache = null;
        if (cmd.ui && typeof cmd.ui.refreshWidgets === 'function') {
          cmd.ui.refreshWidgets();
        }
      } catch {}
    });

    cmd.on('compaction_done', () => {
      try {
        diskCache = null;
        pollContextAndTitle();
      } catch {}
    });

    cmd.on('session_shutdown', teardown);
  }

  if (cmd.clock && typeof cmd.clock.every === 'function') {
    try {
      cmd.clock.every(2000, pollContextAndTitle);
      cmd.clock.every(45000, refreshUsage);
    } catch {
      checkTimer = setInterval(pollContextAndTitle, 2000);
      billingTimer = setInterval(refreshUsage, 45000);
      if (typeof checkTimer.unref === 'function') checkTimer.unref();
      if (typeof billingTimer.unref === 'function') billingTimer.unref();
    }
  } else {
    checkTimer = setInterval(pollContextAndTitle, 2000);
    billingTimer = setInterval(refreshUsage, 45000);
    if (typeof checkTimer.unref === 'function') checkTimer.unref();
    if (typeof billingTimer.unref === 'function') billingTimer.unref();
  }
}
