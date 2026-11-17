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
const SYSTEM_TOOLS_AND_SKILLS = 17000;

function estimateTextTokens(str) {
  if (!str) return 0;
  const s = typeof str === 'string' ? str : String(str);
  const n = s.length / TOKEN_CHAR_RATIO;
  const o = 0.1 * s.split(/\s+/).length;
  return Math.max(0, Math.ceil(n - o));
}

function estimateTokens3(e) {
  if (!e) return 0;
  if (typeof e === 'string') {
    let n = estimateTextTokens(e);
    if (e.startsWith('{') || e.startsWith('[')) n = Math.ceil(n * JSON_RATIO);
    return n;
  }
  let n = 3;
  const content = e.content;
  if (typeof content === 'string') {
    n += estimateTextTokens(content);
  } else if (Array.isArray(content)) {
    for (const o of content) {
      if (!o) continue;
      if (o.type === 'text' && o.text) {
        n += estimateTextTokens(o.text);
      } else if (o.type === 'image') {
        n += 1229;
      } else if (o.type === 'tool-call' || o.type === 'tool_use') {
        n += 5;
        const name = o.toolName || o.name;
        if (name) n += estimateTextTokens(name);
        const inp = o.input || o.arguments;
        if (inp) {
          const s = typeof inp === 'string' ? inp : JSON.stringify(inp);
          n += Math.ceil(estimateTextTokens(s) * JSON_RATIO);
        }
      } else if (o.type === 'tool-result' || o.type === 'tool_result') {
        n += 3;
        const out = o.output;
        if (out && typeof out === 'object' && 'value' in out && typeof out.value === 'string') {
          n += estimateTextTokens(out.value);
        } else if (typeof o.content === 'string') {
          n += estimateTextTokens(o.content);
        } else if (Array.isArray(o.content)) {
          for (const c of o.content) {
            if (typeof c === 'string') n += estimateTextTokens(c);
            else if (c && c.text) n += estimateTextTokens(c.text);
            else if (c) n += estimateTextTokens(JSON.stringify(c));
          }
        }
      }
    }
  }
  return n;
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

function getLatestContextUsage(workingDir = process.cwd()) {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const norm = path.resolve(workingDir);
    let dirName = '';
    if (process.platform === 'win32') {
      const drive = norm.charAt(0).toLowerCase();
      const slug = norm.replace(/^[a-zA-Z]:[\\/]/, '').replace(/[\\/]/g, '-').toLowerCase();
      dirName = `${drive}-${slug}`;
    } else {
      dirName = norm.replace(/^\//, '').replace(/\//g, '-').toLowerCase();
    }

    const projectStore = path.join(home, '.commandcode', 'projects', dirName);
    if (!fs.existsSync(projectStore)) return null;

    const files = fs.readdirSync(projectStore)
      .filter(f => f.endsWith('.jsonl') && !f.includes('checkpoint'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(projectStore, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;
    const latestJsonl = path.join(projectStore, files[0].name);

    const lines = fs.readFileSync(latestJsonl, 'utf8').trim().split('\n');
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

    let compactionIdx = -1;
    for (let i = pathEntries.length - 1; i >= 0; i--) {
      if (pathEntries[i].type === 'compaction') {
        compactionIdx = i;
        break;
      }
    }

    let messages = [];
    if (compactionIdx === -1) {
      messages = pathEntries.flatMap(entryToContextMessages);
    } else {
      const comp = pathEntries[compactionIdx];
      const kept = [comp];
      let foundFirst = false;
      for (let i = 0; i < compactionIdx; i++) {
        const e = pathEntries[i];
        if (!foundFirst) {
          if (e.id !== comp.firstKeptEntryId) continue;
          foundFirst = true;
        }
        kept.push(e);
      }
      for (let i = compactionIdx + 1; i < pathEntries.length; i++) {
        kept.push(pathEntries[i]);
      }

      const pathIdxMap = new Map(pathEntries.map((e, idx) => [e.id, idx]));
      for (const e of kept) {
        const msgs = entryToContextMessages(e);
        const idx = pathIdxMap.get(e.id);
        if (idx === undefined || idx >= compactionIdx) {
          messages.push(...msgs);
        } else {
          messages.push(...stripThinking(msgs));
        }
      }
    }

    let conversationTokens = 0;
    for (const m of messages) {
      if (m && !m.meta?.isMeta) {
        conversationTokens += estimateTokens3(m);
      }
    }

    const totalTokens = conversationTokens + SYSTEM_TOOLS_AND_SKILLS;
    return formatTokens(totalTokens, 1000000);
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
  let cachedCtx = null;
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

  function getActiveContextUsage(workingDir) {
    if (cachedCtx) return cachedCtx;
    const fromDisk = getLatestContextUsage(workingDir);
    if (fromDisk) {
      cachedCtx = fromDisk;
      return fromDisk;
    }
    if (typeof cmd.getContextUsage === 'function') {
      try {
        const cu = cmd.getContextUsage();
        if (cu && typeof cu.tokens === 'number' && cu.tokens > 0) {
          return formatTokens(cu.tokens, cu.contextWindow || 1000000);
        }
      } catch {}
    }
    return 'ctx 0k/1M · 0%';
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
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const norm = path.resolve(workingDir);
      let dirName = '';
      if (process.platform === 'win32') {
        const drive = norm.charAt(0).toLowerCase();
        const slug = norm.replace(/^[a-zA-Z]:[\\/]/, '').replace(/[\\/]/g, '-').toLowerCase();
        dirName = `${drive}-${slug}`;
      } else {
        dirName = norm.replace(/^\//, '').replace(/\//g, '-').toLowerCase();
      }

      const projectStore = path.join(home, '.commandcode', 'projects', dirName);
      if (fs.existsSync(projectStore)) {
        const files = fs.readdirSync(projectStore)
          .filter(f => f.endsWith('.jsonl') && !f.includes('checkpoint'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(projectStore, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);

        if (files.length > 0 && files[0].mtime !== lastMtime) {
          lastMtime = files[0].mtime;
          cachedCtx = getLatestContextUsage(workingDir);
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

    cmd.on('compaction_outcome', (evt) => {
      try {
        if (evt && typeof evt.tokensAfter === 'number' && evt.tokensAfter > 0) {
          cachedCtx = formatTokens(evt.tokensAfter + SYSTEM_TOOLS_AND_SKILLS, evt.contextLimit || 1000000);
        } else {
          cachedCtx = null;
        }
        if (cmd.ui && typeof cmd.ui.refreshWidgets === 'function') {
          cmd.ui.refreshWidgets();
        }
      } catch {}
    });

    cmd.on('compaction_done', () => {
      try {
        cachedCtx = null;
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
