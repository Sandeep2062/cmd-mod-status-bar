import https from 'https';
import fs from 'fs';
import path from 'path';

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

function formatTokens(tokens, limit = 1000000) {
  if (typeof tokens !== 'number' || isNaN(tokens) || tokens <= 0) return 'ctx 0k/1M · 0%';
  const kTokens = tokens >= 1000000
    ? (tokens / 1000000).toFixed(1) + 'M'
    : (tokens >= 10000 ? Math.round(tokens / 1000) + 'k' : (tokens / 1000).toFixed(1) + 'k');
  const maxLimit = (typeof limit === 'number' && limit > 0) ? limit : 1000000;
  const pct = Math.round((tokens / maxLimit) * 100);
  const limitStr = maxLimit >= 1000000 ? `${Math.round(maxLimit / 1000000)}M` : `${Math.round(maxLimit / 1000)}k`;
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

try {
  process.on('exit', cleanupInstance);
  process.on('SIGINT', cleanupInstance);
  process.on('SIGTERM', cleanupInstance);
} catch {}

const TOKEN_CHAR_RATIO = 3.5;
const SYSTEM_TOOLS_AND_SKILLS = 17000;

function estimateTextTokens(str) {
  if (!str) return 0;
  const s = typeof str === 'string' ? str : String(str);
  const n = s.length / TOKEN_CHAR_RATIO;
  const o = 0.1 * s.split(/\s+/).length;
  return Math.max(0, Math.ceil(n - o));
}

function estimateMessageTokens(m) {
  if (!m) return 0;
  let tokens = 3;
  const content = m.content;
  if (typeof content === 'string') return tokens + estimateTextTokens(content);
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'text') {
        tokens += estimateTextTokens(b.text || '');
      } else if (b.type === 'tool_use' || b.type === 'tool-call') {
        tokens += 5;
        const name = b.name || b.toolName;
        if (name) tokens += estimateTextTokens(name);
        const input = b.input || b.arguments;
        if (input) tokens += Math.ceil(estimateTextTokens(JSON.stringify(input)) * 1.1);
      } else if (b.type === 'tool_result' || b.type === 'tool-result') {
        tokens += 3;
        let val = '';
        if (typeof b.content === 'string') val = b.content;
        else if (Array.isArray(b.content)) {
          val = b.content.map(c => typeof c === 'string' ? c : (c.text || JSON.stringify(c))).join('\n');
        } else if (b.output && typeof b.output === 'object' && b.output.value) {
          val = b.output.value;
        }
        tokens += estimateTextTokens(val);
      } else if (b.type === 'image') {
        tokens += 1229;
      }
    }
  }
  return Math.ceil(tokens);
}

function calculateConversationTokens(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  let total = SYSTEM_TOOLS_AND_SKILLS;
  for (const m of messages) {
    if (m && !m.meta?.isMeta) {
      total += estimateMessageTokens(m);
    }
  }
  return total;
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

    let lastCompactionIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'compaction') {
          lastCompactionIdx = i;
          break;
        }
      } catch {}
    }

    const startIdx = lastCompactionIdx !== -1 ? lastCompactionIdx : 0;
    let conversationTokens = 0;
    let latestPostCompactionApiTokens = 0;

    if (lastCompactionIdx !== -1) {
      try {
        const comp = JSON.parse(lines[lastCompactionIdx]);
        if (comp.summary) {
          conversationTokens += estimateTextTokens(comp.summary);
        }
      } catch {}
    }

    for (let i = startIdx + 1; i < lines.length; i++) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'message' && obj.message && !obj.message.meta?.isMeta) {
          conversationTokens += estimateMessageTokens(obj.message);
        }
        if (obj.usage && typeof obj.usage.inputTokens === 'number') {
          latestPostCompactionApiTokens = obj.usage.inputTokens;
        }
      } catch {}
    }

    const estimatedTotal = conversationTokens + SYSTEM_TOOLS_AND_SKILLS;
    const finalTokens = Math.max(estimatedTotal, latestPostCompactionApiTokens);

    return formatTokens(finalTokens, 1000000);
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
    if (typeof cmd.getContextUsage === 'function') {
      try {
        const cu = cmd.getContextUsage();
        if (cu && typeof cu.tokens === 'number' && cu.tokens > 0) {
          return formatTokens(cu.tokens, cu.contextWindow || 1000000);
        }
      } catch {}
    }
    if (cachedCtx) return cachedCtx;
    return getLatestContextUsage(workingDir) || 'ctx 0k/1M · 0%';
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

  if (typeof cmd.hooks === 'function') {
    cmd.hooks({
      onTurnStart(payload) {
        try {
          applyTabTitle();
          if (payload && payload.state && Array.isArray(payload.state.messages)) {
            const tokens = calculateConversationTokens(payload.state.messages);
            if (tokens > 0) {
              cachedCtx = formatTokens(tokens, 1000000);
              if (cmd.ui && typeof cmd.ui.refreshWidgets === 'function') {
                cmd.ui.refreshWidgets();
              }
            }
          }
        } catch {}
        return (payload && payload.state !== undefined) ? payload.state : payload;
      },
      onTurnEnd(payload) {
        try {
          applyTabTitle();
          if (payload && payload.state && Array.isArray(payload.state.messages)) {
            const tokens = calculateConversationTokens(payload.state.messages);
            const usageTokens = (payload.usage && typeof payload.usage.inputTokens === 'number') ? payload.usage.inputTokens : 0;
            const finalTokens = Math.max(tokens, usageTokens);
            if (finalTokens > 0) {
              cachedCtx = formatTokens(finalTokens, 1000000);
            }
          } else if (payload && payload.usage && typeof payload.usage.inputTokens === 'number') {
            cachedCtx = formatTokens(payload.usage.inputTokens, 1000000);
          }
          if (cmd.ui && typeof cmd.ui.refreshWidgets === 'function') {
            cmd.ui.refreshWidgets();
          }
        } catch {}
        return (payload && payload.state !== undefined) ? payload.state : payload;
      },
      onRunEnd() {
        try {
          applyTabTitle();
          refreshUsage();
        } catch {}
      }
    });
  }
}
