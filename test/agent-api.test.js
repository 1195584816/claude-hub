const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createTaskService, startAgentApiServer, buildClaudeInvocation, parseClaudeOutput, createClaudeRunner } = require('../lib/agent-api');
const { writeJsonAtomic } = require('../lib/atomic-json');

function rawRequest(port, raw) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let text = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('raw request timeout')); }, 3000);
    socket.on('connect', () => socket.end(raw));
    socket.on('data', chunk => { text += chunk; });
    socket.on('end', () => { clearTimeout(timer); resolve(text); });
    socket.on('close', () => { if (text) { clearTimeout(timer); resolve(text); } });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

function request(port, method, pathname, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: `Bearer ${token}` } : {},
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}
      )
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text || '{}') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('提交fork任务会继承会话且不触碰GUI终端', async () => {
  const calls = [];
  const service = createTaskService({
    persist: () => {},
    fileExists: () => true,
    runClaude: async request => {
      calls.push(request);
      return { ok: true, result: '完成', sessionId: 'forked-session' };
    }
  });

  const task = service.submit({
    projectPath: 'F:\\claude-project\\panel-fork\\3x-ui',
    sessionId: 'aaaddac9-792b-4eae-ad1b-890acd7036ac',
    mode: 'fork',
    prompt: '检查历史记录',
    attachments: ['C:\\tmp\\issue.jpg']
  });

  assert.equal(task.status, 'queued');
  await service.waitForIdle();

  const done = service.get(task.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.result, '完成');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'fork');
  assert.equal(calls[0].sessionId, 'aaaddac9-792b-4eae-ad1b-890acd7036ac');
  assert.match(calls[0].prompt, /issue\.jpg/);
  assert.match(calls[0].prompt, /检查历史记录/);
});

test('HTTP API拒绝未授权请求并允许令牌提交与查询任务', async t => {
  const service = createTaskService({
    persist: () => {},
    fileExists: () => true,
    runClaude: async () => ({ ok: true, result: 'API完成', sessionId: 'forked' })
  });
  const api = await startAgentApiServer({
    host: '127.0.0.1', port: 0, token: 'test-secret', service,
    getProjects: () => [{ short: '测试项目', path: 'F:\\work', mainSession: 'aaaddac9-792b-4eae-ad1b-890acd7036ac' }],
    getSessions: projectPath => projectPath === 'F:\\work' ? [{ id: 'aaaddac9-792b-4eae-ad1b-890acd7036ac', title: '主会话' }] : []
  });
  t.after(() => api.close());

  const unauthorized = await request(api.port, 'GET', '/api/v1/tasks', '', undefined);
  assert.equal(unauthorized.status, 401);

  const submitted = await request(api.port, 'POST', '/api/v1/tasks', 'test-secret', {
    projectPath: 'F:\\work', sessionId: 'aaaddac9-792b-4eae-ad1b-890acd7036ac',
    mode: 'fork', prompt: '执行测试'
  });
  assert.equal(submitted.status, 202);
  assert.equal(submitted.body.task.status, 'queued');

  await service.waitForIdle();
  const queried = await request(api.port, 'GET', `/api/v1/tasks/${submitted.body.task.id}`, 'test-secret');
  assert.equal(queried.status, 200);
  assert.equal(queried.body.task.result, 'API完成');

  const projects = await request(api.port, 'GET', '/api/v1/projects', 'test-secret');
  assert.equal(projects.status, 200);
  assert.equal(projects.body.projects[0].short, '测试项目');

  const sessions = await request(api.port, 'GET', `/api/v1/sessions?projectPath=${encodeURIComponent('F:\\work')}`, 'test-secret');
  assert.equal(sessions.status, 200);
  assert.equal(sessions.body.sessions[0].title, '主会话');
});

test('畸形请求目标返回400且不会产生未处理拒绝', async t => {
  const service = createTaskService({
    persist: () => {}, fileExists: () => true,
    runClaude: async () => ({ ok: true, result: 'ok', sessionId: 'new' })
  });
  const api = await startAgentApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
  t.after(() => api.close());
  let rejection = null;
  const onRejection = error => { rejection = error; };
  process.once('unhandledRejection', onRejection);
  t.after(() => process.removeListener('unhandledRejection', onRejection));

  const response = await rawRequest(api.port, 'GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(response, /^HTTP\/1\.1 400/);
  assert.equal(rejection, null);
});

test('超过1MB的请求体返回413且不进入任务队列', async t => {
  const service = createTaskService({
    persist: () => {}, fileExists: () => true,
    runClaude: async () => ({ ok: true, result: 'ok', sessionId: 'new' })
  });
  const api = await startAgentApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
  t.after(() => api.close());

  const response = await request(api.port, 'POST', '/api/v1/tasks', 'secret', {
    projectPath: 'F:\\work', mode: 'new', prompt: 'x'.repeat(1024 * 1024 + 100)
  });
  assert.equal(response.status, 413);
  assert.equal(service.list().length, 0);
});

test('任务串行执行且排队任务可以取消', async () => {
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const started = [];
  const service = createTaskService({
    persist: () => {}, fileExists: () => true,
    runClaude: async req => {
      started.push(req.taskId);
      if (started.length === 1) await firstGate;
      return { ok: true, result: 'done', sessionId: 'forked' };
    }
  });
  const base = {
    projectPath: 'F:\\work', sessionId: 'aaaddac9-792b-4eae-ad1b-890acd7036ac',
    mode: 'fork', prompt: '任务'
  };
  const first = service.submit(base);
  const second = service.submit(base);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(started.length, 1);
  assert.equal(service.cancel(second.id), true);
  assert.equal(service.get(second.id).status, 'cancelled');

  releaseFirst();
  await service.waitForIdle();
  assert.equal(service.get(first.id).status, 'completed');
  assert.equal(started.length, 1);
});

test('Claude命令行只包含受控参数且提示词仅走stdin', () => {
  const prompt = '不要执行 & del C:\\important';
  const invocation = buildClaudeInvocation({
    claudeCmd: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
    mode: 'fork', sessionId: 'aaaddac9-792b-4eae-ad1b-890acd7036ac',
    maxTurns: 25, prompt
  });

  assert.equal(invocation.command, 'powershell.exe');
  assert.match(invocation.args.join(' '), /--resume aaaddac9-792b-4eae-ad1b-890acd7036ac/);
  assert.match(invocation.args.join(' '), /--fork-session/);
  assert.match(invocation.args.join(' '), /--output-format json/);
  assert.doesNotMatch(invocation.args.join(' '), /important|不要执行/);
  assert.equal(invocation.stdin, prompt);
});

test('解析Claude JSON输出得到最终回复和新会话ID', () => {
  const parsed = parseClaudeOutput(JSON.stringify({
    type: 'result', subtype: 'success', result: '最终回复',
    session_id: '11111111-2222-3333-4444-555555555555'
  }), '');
  assert.deepEqual(parsed, {
    ok: true, result: '最终回复',
    sessionId: '11111111-2222-3333-4444-555555555555'
  });

  const failed = parseClaudeOutput(JSON.stringify({
    type: 'result', subtype: 'error_max_turns', result: '未完成'
  }), '');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /error_max_turns/);
});

test('Claude执行器使用项目cwd和stdin并解析进程结果', async () => {
  let spawned = null;
  let stdinText = '';
  const spawnFn = (command, args, options) => {
    spawned = { command, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = {
      end(text) {
        stdinText = text;
        setImmediate(() => {
          child.stdout.write(JSON.stringify({
            type: 'result', subtype: 'success', result: '已完成',
            session_id: '11111111-2222-3333-4444-555555555555'
          }));
          child.stdout.end(); child.stderr.end(); child.emit('close', 0);
        });
      }
    };
    child.kill = () => {};
    return child;
  };
  const runner = createClaudeRunner({
    spawnFn, claudeCmd: 'C:\\tools\\claude.cmd', timeoutMs: 5000,
    env: { PATH: 'x', CLAUDE_CODE_ENTRYPOINT: 'nested' }
  });
  const result = await runner({
    projectPath: 'F:\\work', mode: 'fork',
    sessionId: 'aaaddac9-792b-4eae-ad1b-890acd7036ac',
    maxTurns: 10, prompt: '从stdin发送'
  });

  assert.equal(spawned.options.cwd, 'F:\\work');
  assert.equal(spawned.options.env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(stdinText, '从stdin发送');
  assert.equal(result.ok, true);
  assert.equal(result.result, '已完成');
});

test('stdin异步EPIPE被转成任务失败而不是未处理error', async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new EventEmitter();
    child.stdin.end = () => setImmediate(() => {
      child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
      child.emit('close', 1);
    });
    child.kill = () => {};
    return child;
  };
  const runner = createClaudeRunner({ spawnFn, claudeCmd: 'C:\\tools\\claude.cmd', timeoutMs: 5000 });
  const result = await runner({ projectPath: 'F:\\work', mode: 'new', maxTurns: 1, prompt: 'test' });
  assert.equal(result.ok, false);
  assert.match(result.error, /EPIPE|broken pipe/);
});

test('超时后等待进程树终止确认再结束任务', async () => {
  let releaseTermination;
  let terminateCalled = false;
  let settled = false;
  const terminationGate = new Promise(resolve => { releaseTermination = resolve; });
  const spawnFn = () => {
    const child = new EventEmitter();
    child.pid = 12345;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.kill = () => {};
    return child;
  };
  const runner = createClaudeRunner({
    spawnFn, claudeCmd: 'C:\\tools\\claude.cmd', timeoutMs: 1000,
    terminateProcess: async () => { terminateCalled = true; await terminationGate; }
  });
  const pending = runner({ projectPath: 'F:\\work', mode: 'new', maxTurns: 1, prompt: 'test' })
    .then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(terminateCalled, true);
  assert.equal(settled, false);
  releaseTermination();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /超时/);
});

test('超时后即使父进程先close也等待进程树终止确认', async () => {
  let releaseTermination;
  let child;
  let settled = false;
  const gate = new Promise(resolve => { releaseTermination = resolve; });
  const spawnFn = () => {
    child = new EventEmitter();
    child.pid = 12345;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.kill = () => {};
    return child;
  };
  const runner = createClaudeRunner({
    spawnFn, claudeCmd: 'C:\\tools\\claude.cmd', timeoutMs: 1000,
    terminateProcess: async () => { await gate; }
  });
  const pending = runner({ projectPath: 'F:\\work', mode: 'new', maxTurns: 1, prompt: 'test' })
    .then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 1050));
  child.emit('close', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  releaseTermination();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /超时/);
});

test('原子JSON写入可安全覆盖且不残留临时文件', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudehub-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'state.json');
  writeJsonAtomic(target, { version: 1 });
  writeJsonAtomic(target, { version: 2, ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { version: 2, ok: true });
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test('初始持久化失败会回滚任务且不会启动Claude', () => {
  let runnerCalls = 0;
  const service = createTaskService({
    persist: () => { throw new Error('disk full'); }, fileExists: () => true,
    runClaude: async () => { runnerCalls++; return { ok: true, result: 'x' }; }
  });
  assert.throws(() => service.submit({
    projectPath: 'F:\\work', mode: 'new', prompt: 'test'
  }), /持久化|disk full/);
  assert.equal(service.list().length, 0);
  assert.equal(runnerCalls, 0);
});

test('运行状态持久化失败时任务失败且Claude不启动', async () => {
  let persistCalls = 0, runnerCalls = 0;
  const service = createTaskService({
    persist: () => { if (++persistCalls === 2) throw new Error('disk unavailable'); },
    fileExists: () => true,
    runClaude: async () => { runnerCalls++; return { ok: true, result: 'x' }; }
  });
  const task = service.submit({ projectPath: 'F:\\work', mode: 'new', prompt: 'test' });
  await service.waitForIdle();
  assert.equal(runnerCalls, 0);
  assert.equal(service.get(task.id).status, 'failed');
  assert.match(service.get(task.id).error, /持久化/);
});

test('完成状态持久化失败会保留结果并显式标记persistenceError', async () => {
  let persistCalls = 0;
  const service = createTaskService({
    persist: () => { if (++persistCalls === 3) throw new Error('disk unavailable'); },
    fileExists: () => true,
    runClaude: async () => ({ ok: true, result: '真实结果', sessionId: 'new-session' })
  });
  const task = service.submit({ projectPath: 'F:\\work', mode: 'new', prompt: 'test' });
  await service.waitForIdle();
  const done = service.get(task.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.result, '真实结果');
  assert.match(done.persistenceError, /disk unavailable/);
});

test('重启后恢复历史任务并把中断任务标记失败', () => {
  const service = createTaskService({
    persist: () => {}, fileExists: () => true,
    runClaude: async () => ({ ok: true, result: '' }),
    initialTasks: [
      { id: '11111111-1111-1111-1111-111111111111', status: 'completed', createdAt: 1, result: '旧结果' },
      { id: '22222222-2222-2222-2222-222222222222', status: 'running', createdAt: 2, result: '' }
    ]
  });
  assert.equal(service.get('11111111-1111-1111-1111-111111111111').result, '旧结果');
  const interrupted = service.get('22222222-2222-2222-2222-222222222222');
  assert.equal(interrupted.status, 'failed');
  assert.match(interrupted.error, /应用重启/);
});
