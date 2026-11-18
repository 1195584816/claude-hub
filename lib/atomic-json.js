const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function writeJsonAtomic(targetPath, value) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

// 异步版:主进程 IPC 里用,不卡住主线程(硬规矩 2)。步骤和上面一样:写临时文件 → fsync → 改名
async function writeJsonAtomicAsync(targetPath, value) {
  const dir = path.dirname(targetPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let fh = null;
  try {
    fh = await fs.promises.open(tempPath, 'wx', 0o600);
    await fh.writeFile(JSON.stringify(value, null, 2), 'utf8');
    await fh.sync();
    await fh.close();
    fh = null;
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    if (fh !== null) {
      try { await fh.close(); } catch {}
    }
    try { await fs.promises.unlink(tempPath); } catch {}
    throw error;
  }
}

module.exports = { writeJsonAtomic, writeJsonAtomicAsync };
