const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

function createTaskService(options = {}) {
  const runClaude = options.runClaude;
  const persist = options.persist || (() => {});
  const fileExists = options.fileExists || (() => false);
  const isProjectAllowed = options.isProjectAllowed || (() => true);
  if (typeof runClaude !== 'function') throw new Error('runClaude is required');

  const tasks = new Map();
  for (const raw of options.initialTasks || []) {
    if (!raw || !/^[0-9a-f-]{36}$/i.test(String(raw.id || ''))) continue;
    const task = Object.assign({
      status: 'failed', projectPath: '', sessionId: '', mode: 'fork', prompt: '',
      attachments: [], composedPrompt: '', maxTurns: 50, createdAt: 0,
      startedAt: 0, finishedAt: 0, result: '', resultSessionId: '', error: ''
    }, JSON.parse(JSON.stringify(raw)));
    if (task.status === 'queued' || task.status === 'running') {
      task.status = 'failed';
      task.finishedAt = Date.now();
      task.error = '任务因ClaudeHub应用重启而中断';
      persist(JSON.parse(JSON.stringify(task)));
    }
    tasks.set(task.id, task);
  }
  const queue = [];
  let running = false;
  let idleWaiters = [];

  function publicTask(task) {
    const copy = JSON.parse(JSON.stringify(task));
    delete copy.composedPrompt;
    return copy;
  }

  function save(task) {
    persist(publicTask(task));
  }

  function buildPrompt(prompt, attachments) {
    const files = (attachments || []).map(String);
    for (const file of files) {
      if (!fileExists(file)) throw new Error(`附件不存在: ${file}`);
    }
    if (!files.length) return String(prompt || '');
    return files.map(file => `"${file}"`).join('\n') + '\n\n' + String(prompt || '');
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const task = queue.shift();
        if (task.status === 'cancelled') continue;
        task.status = 'running';
        task.startedAt = Date.now();
        try {
          save(task);
        } catch (error) {
          task.status = 'failed';
          task.finishedAt = Date.now();
          task.error = `运行状态持久化失败: ${String(error && error.message ? error.message : error)}`;
          task.persistenceError = task.error;
          try { save(task); } catch {}
          continue;
        }
        try {
          const result = await runClaude({
            taskId: task.id,
            projectPath: task.projectPath,
            sessionId: task.sessionId,
            mode: task.mode,
            prompt: task.composedPrompt,
            maxTurns: task.maxTurns
          });
          if (!result || result.ok === false) throw new Error((result && result.error) || 'Claude任务失败');
          task.status = 'completed';
          task.result = String(result.result || '');
          task.resultSessionId = String(result.sessionId || '');
        } catch (error) {
          task.status = 'failed';
          task.error = String(error && error.message ? error.message : error);
        }
        task.finishedAt = Date.now();
        try {
          save(task);
        } catch (error) {
          task.persistenceError = `完成状态持久化失败: ${String(error && error.message ? error.message : error)}`;
        }
      }
    } finally {
      running = false;
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  function submit(input = {}) {
    const prompt = String(input.prompt || '').trim();
    if (!prompt) throw new Error('prompt不能为空');
    const mode = input.mode || 'fork';
    if (!['fork', 'resume', 'new'].includes(mode)) throw new Error('mode必须是fork、resume或new');
    const sessionId = String(input.sessionId || '');
    if (mode !== 'new' && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(sessionId)) throw new Error('sessionId不合法');
    const projectPath = String(input.projectPath || '');
    if (!projectPath) throw new Error('projectPath不能为空');
    if (!isProjectAllowed(projectPath)) throw new Error('projectPath不在ClaudeHub项目清单中');

    const task = {
      id: crypto.randomUUID(),
      status: 'queued',
      projectPath,
      sessionId,
      mode,
      prompt,
      attachments: (input.attachments || []).map(String),
      composedPrompt: buildPrompt(prompt, input.attachments),
      maxTurns: Math.max(1, Math.min(100, Number(input.maxTurns) || 50)),
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
      result: '',
      resultSessionId: '',
      error: ''
    };
    tasks.set(task.id, task);
    queue.push(task);
    try {
      save(task);
    } catch (error) {
      tasks.delete(task.id);
      const index = queue.indexOf(task);
      if (index >= 0) queue.splice(index, 1);
      throw new Error(`任务持久化失败: ${String(error && error.message ? error.message : error)}`);
    }
    queueMicrotask(drain);
    return publicTask(task);
  }

  return {
    submit,
    get(id) {
      const task = tasks.get(id);
      return task ? publicTask(task) : null;
    },
    list() {
      return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).map(publicTask);
    },
    cancel(id) {
      const task = tasks.get(id);
      if (!task || task.status !== 'queued') return false;
      task.status = 'cancelled';
      task.finishedAt = Date.now();
      task.error = 'cancelled';
      save(task);
      return true;
    },
    waitForIdle() {
      if (!running && queue.length === 0) return Promise.resolve();
      return new Promise(resolve => idleWaiters.push(resolve));
    }
  };
}

function buildClaudeInvocation(options = {}) {
  const claudeCmd = String(options.claudeCmd || 'claude.cmd');
  if (!claudeCmd || claudeCmd.includes('"') || /[\r\n]/.test(claudeCmd)) throw new Error('claudeCmd不合法');
  const mode = options.mode || 'fork';
  if (!['fork', 'resume', 'new'].includes(mode)) throw new Error('mode不合法');
  const sessionId = String(options.sessionId || '');
  if (mode !== 'new' && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(sessionId)) throw new Error('sessionId不合法');
  const maxTurns = Math.max(1, Math.min(100, Number(options.maxTurns) || 50));
  const psPath = claudeCmd.replace(/'/g, "''");
  const parts = [
    `& '${psPath}'`, '--print', '--output-format json',
    `--max-turns ${maxTurns}`
  ];
  if (mode !== 'new') parts.push(`--resume ${sessionId}`);
  if (mode === 'fork') parts.push('--fork-session');
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', parts.join(' ')],
    stdin: String(options.prompt || '')
  };
}

function parseClaudeOutput(stdout, stderr) {
  const text = String(stdout || '').trim();
  let payload = null;
  try { payload = JSON.parse(text); } catch {
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && !payload; i--) {
      try { payload = JSON.parse(lines[i]); } catch {}
    }
  }
  if (!payload) {
    return { ok: false, error: String(stderr || text || 'Claude没有返回JSON结果') };
  }
  if (payload.subtype !== 'success') {
    return {
      ok: false,
      error: `${payload.subtype || 'claude_error'}${payload.result ? ': ' + payload.result : ''}`,
      sessionId: String(payload.session_id || '')
    };
  }
  return {
    ok: true,
    result: String(payload.result || ''),
    sessionId: String(payload.session_id || '')
  };
}

function terminateChildProcess(child) {
  if (!child || child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve();
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    return new Promise((resolve, reject) => {
      let killer;
      try {
        killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore'
        });
      } catch (error) { reject(error); return; }
      killer.once('error', reject);
      killer.once('close', code => code === 0 ? resolve() : reject(new Error(`taskkill退出码 ${code}`)));
    });
  }
  return new Promise((resolve, reject) => {
    const onClose = () => resolve();
    child.once('close', onClose);
    try { child.kill('SIGKILL'); }
    catch (error) { child.removeListener('close', onClose); reject(error); }
  });
}

function createClaudeRunner(options = {}) {
  const spawnFn = options.spawnFn || spawn;
  const terminateProcess = options.terminateProcess || terminateChildProcess;
  const claudeCmd = options.claudeCmd || 'claude.cmd';
  const baseEnv = options.env || process.env;
  // envFn:每个任务开始时现算一份环境(主进程用它让任务跟着当时的系统代理走)。
  // 不给就用上面那份固定的,行为和以前一样、而且是同步的。它抛错 / 返回怪东西也退回固定那份。
  const envFn = typeof options.envFn === 'function' ? options.envFn : null;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30 * 60e3);
  const maxOutput = Math.max(1024, Number(options.maxOutput) || 8 * 1024 * 1024);

  // ⚠️ 要等的东西(envFn)放在 new Promise 外面等。不能把执行器写成 async:执行器里一旦抛错,
  //    同步执行器会让 Promise 变成 rejected,async 执行器却会让它**永远挂着** —— 任务队列是串行的,
  //    一个任务不结束,后面的全排不上。没给 envFn 时这里没有 await,和以前一样是调用当下就起进程。
  return async request => {
    let base = baseEnv;
    if (envFn) {
      try { const got = await envFn(); if (got && typeof got === 'object') base = got; } catch {}
    }
    return new Promise(resolve => {
    let invocation;
    try {
      invocation = buildClaudeInvocation({
        claudeCmd,
        mode: request.mode,
        sessionId: request.sessionId,
        maxTurns: request.maxTurns,
        prompt: request.prompt
      });
    } catch (error) {
      resolve({ ok: false, error: String(error.message || error) });
      return;
    }

    const env = {};
    for (const [key, value] of Object.entries(base)) {
      if (!/^CLAUDE_?CODE/i.test(key)) env[key] = value;
    }
    let stdout = '', stderr = '', settled = false;
    let child, timer = null;
    let timedOut = false, stdinError = '';
    const finish = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawnFn(invocation.command, invocation.args, {
        cwd: request.projectPath,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ ok: false, error: String(error.message || error) });
      return;
    }
    const add = (current, chunk) => {
      const next = current + String(chunk);
      return next.length > maxOutput ? next.slice(-maxOutput) : next;
    };
    child.stdout.on('data', chunk => { stdout = add(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = add(stderr, chunk); });
    child.on('error', error => finish({ ok: false, error: String(error.message || error) }));
    if (child.stdin && typeof child.stdin.on === 'function') {
      child.stdin.on('error', error => {
        stdinError = `${error && error.code ? error.code + ': ' : ''}${String(error && error.message ? error.message : error)}`;
      });
    }
    child.on('close', code => {
      // 超时后父进程close不代表其后代进程树已终止；必须等terminateProcess确认。
      if (timedOut) return;
      if (stdinError) return finish({ ok: false, error: `Claude stdin失败: ${stdinError}` });
      const result = parseClaudeOutput(stdout, stderr);
      if (code !== 0 && result.ok) return finish({ ok: false, error: `Claude退出码 ${code}` });
      if (code !== 0 && !result.ok) result.error = `Claude退出码 ${code}: ${result.error}`;
      finish(result);
    });
    timer = setTimeout(() => {
      timedOut = true;
      Promise.resolve()
        .then(() => terminateProcess(child))
        .then(() => finish({ ok: false, error: `Claude任务超时(${timeoutMs}ms)` }))
        .catch(error => {
          stderr = add(stderr, `\n终止进程树失败: ${String(error && error.message ? error.message : error)}`);
          // 终止结果未确认时不释放任务队列；等待真实close，避免与下一任务并发。
          try { child.kill(); } catch {}
        });
    }, timeoutMs);
    try { child.stdin.end(invocation.stdin); }
    catch (error) { finish({ ok: false, error: String(error.message || error) }); }
    });
  };
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        done = true;
        const error = new Error('请求体过大');
        error.statusCode = 413;
        reject(error);
        // 继续排空socket但不再保留数据，避免大请求导致内存持续增长。
        req.removeAllListeners('data');
        req.on('data', () => {});
        req.resume();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks, size).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('JSON格式错误')); }
    });
    req.on('error', error => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

function startAgentApiServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = Number.isInteger(options.port) ? options.port : 8765;
  const token = String(options.token || '');
  const service = options.service;
  const getProjects = options.getProjects || (() => []);
  const getSessions = options.getSessions || (() => []);
  if (!token) return Promise.reject(new Error('API token不能为空'));
  if (!service) return Promise.reject(new Error('task service不能为空'));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/health' && req.method === 'GET') {
        return json(res, 200, { ok: true, service: 'claudehub-agent-api' });
      }
      const auth = String(req.headers.authorization || '');
      const expected = `Bearer ${token}`;
      const a = Buffer.from(auth);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return json(res, 401, { ok: false, error: 'unauthorized' });
      }

      if (url.pathname === '/api/v1/projects' && req.method === 'GET') {
        return json(res, 200, { ok: true, projects: getProjects() });
      }
      if (url.pathname === '/api/v1/sessions' && req.method === 'GET') {
        const projectPath = String(url.searchParams.get('projectPath') || '');
        if (!projectPath) throw new Error('projectPath不能为空');
        return json(res, 200, { ok: true, sessions: getSessions(projectPath) });
      }
      if (url.pathname === '/api/v1/tasks' && req.method === 'GET') {
        return json(res, 200, { ok: true, tasks: service.list() });
      }
      if (url.pathname === '/api/v1/tasks' && req.method === 'POST') {
        const task = service.submit(await readJson(req));
        return json(res, 202, { ok: true, task });
      }
      const match = url.pathname.match(/^\/api\/v1\/tasks\/([0-9a-f-]+)$/i);
      if (match && req.method === 'GET') {
        const task = service.get(match[1]);
        return task ? json(res, 200, { ok: true, task }) : json(res, 404, { ok: false, error: 'task_not_found' });
      }
      if (match && req.method === 'DELETE') {
        return service.cancel(match[1])
          ? json(res, 200, { ok: true })
          : json(res, 409, { ok: false, error: 'task_not_cancellable' });
      }
      return json(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      if (res.headersSent || res.writableEnded) {
        try { res.destroy(); } catch {}
        return;
      }
      const status = Number(error && error.statusCode) || 400;
      return json(res, status, { ok: false, error: String(error && error.message ? error.message : error) });
    }
  });

  return new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      const address = server.address();
      resolve({
        host,
        port: address.port,
        close: () => new Promise(done => server.close(done)),
        server
      });
    });
  });
}

module.exports = { createTaskService, startAgentApiServer, buildClaudeInvocation, parseClaudeOutput, createClaudeRunner };
