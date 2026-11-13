// 用量记账:从会话转录聚合 usage 字段(与官方计费同源),增量解析+缓存
const fs = require('fs');
const path = require('path');

// 路径每次用时才取,而且记住上次取的是哪个 —— 测试要把账本换到临时目录去,
// 不然跑一次测试就把他真实的账本缓存写坏了。
let cache = null, cachePath = null, saveTimer = null;
// 读账本失败过、而且连证据副本都没留下 → 这一轮禁止落盘(见 load 里的论证)
let writeLocked = false, lastBakAt = 0;
// loadOk:这一程**成功读出过**盘上那份账本(或者确认它根本不存在)。
// 读失败之后绝不许再碰 .bak —— 那一刻盘上就是坏数据,拷过去等于把唯一的好备份顶掉(第五轮验收 P1-1 实测)。
// badSig:已经留过 .bad-* 证据副本的**那一份**坏账本的签名。重试每 60 秒一次,不记下来
// 就会每分钟多攒一份坏账本副本,磁盘上堆到没完。
let loadOk = true, lockedAt = 0;
// 已经留过证据副本的**那一份坏账本**的签名(size:mtimeMs)。不是布尔值 —— 见 load() 里的说明。
let badSig = '';
// 滚动备份的间隔。可用 HUB_BAK_EVERY_MS 覆盖(测试用) —— 原来是写死的常量,
// 于是「十分钟」这个数和「备份完要记下时间」这件事都没法钉(第九轮验收 H1-8 / H1-11 都存活)。
function bakEveryMs() { const v = Number(process.env.HUB_BAK_EVERY_MS); return (v >= 0 && isFinite(v)) ? v : 10 * 60 * 1000; }
// 读失败之后每 60 秒允许重读一次:占用类故障(杀毒、备份软件)几百毫秒就过去了,
// 而原来 cache = {} 是真值 → load() 再也不进那个分支 → writeLocked 锁死**整个进程**,
// 他这一整天的用量一条都不落盘,唯一提示是主进程 console.warn(他看不到)。第五轮验收 P2-1 实测。
// 测试要能把这个间隔调短(默认 60 秒,测试里等不起),和 HUB_PARSE_CHUNK 一个路子。
function reloadRetryMs() { const v = Number(process.env.HUB_LEDGER_RETRY_MS); return (v > 0) ? v : 60 * 1000; }

// ⚠️⚠️ 这个函数是账本唯一的入口,也曾经是账本唯一的毁灭路径(第四轮验收 P1)。
// 原来是 `catch { cache = {} }` —— 任何读失败都当成「还没有账本」:
// Windows 上杀毒/备份软件短暂占用(EBUSY/EPERM)、磁盘坏块、文件被手改坏、
// 以前非原子写留下的半截文件……接着随便哪次 save() 就把 {} 原子地写回去,
// 222 个会话、几个月的累计用量一次没,而且 usage-cache.json 一份备份都没有
// (projects.json / session-titles.json 都有 .bak,偏偏最值钱的这份没有)。
// 现在的规矩:
//   · ENOENT(真的没有这个文件)→ 空账本,正常,照常写
//   · 其它任何错误 → 盘上**有**数据只是读不出来:先把它整份另存成 .bad-<时间戳>,
//     存成功了才允许继续写(证据已经留下,覆盖不再是毁灭);存不下来就**锁死写入**,
//     宁可这一程不记账,也不许把好数据顶掉。
// 把备份里有、而 cache 里没有的条目并回来。
// ⚠️ 这是整条链子的**根因修法**。前五轮(五~九)都在修「备份该怎么选」,而真正的病根是:
// 任何一次损坏之后 cache={},warmup 只能按**还在盘上的转录**重建 —— 他 229 条里只有 194 条
// 还有转录(最老的转录只到 2026-08-19,而账本数据跨 173 天),剩下 35 条孤儿占 14.3% 字节、
// **16.4% 累计 token(173.8 亿)**,从此永久消失。账本一变差,后面不管怎么挑备份都是在挑残次品。
// 并回来之后账本**不会变差**,「好备份被更差的数据顶掉」这个形状就不存在了。
//
// 为什么安全:只补 cache 里**没有**的键,绝不覆盖算出来的值。
//   · 孤儿(转录已经不在盘上)→ 它们的数值永不再变,带回来的就是最后的真值;
//   · 转录还在的 → 补进来的 entry.size 要么和当前转录接得上(parseNew 接着读),
//     要么大于当前大小(走变短重算、从 0 整份重新算),两条路都对。
//   · 备份本身坏了 → JSON.parse 抛,跳过,什么都不做。
function mergeBackups(fp, cur) {
  let added = 0;
  for (const slot of ['.bak', '.bak2']) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(fp + slot, 'utf8')); } catch { continue; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
    for (const k in j) {
      if (cur[k]) continue;
      const e = j[k];
      if (!e || typeof e !== 'object') continue;
      // ⚠️ 只补**转录已经不在盘上**的那些(真孤儿)。转录还在的绝不能补:
      // 备份里那条带着一个**旧的偏移**(entry.size),补进来之后 parseNew 会从那个偏移接着读
      // —— 转录要是被重建过(同一个路径、不同内容),那个偏移就落在半行中间,数直接错。
      // 转录还在的让 warmup 从 0 整份重算,永远是对的;而孤儿的数值永不再变,补回来就是最后的真值。
      // (这个洞是我自己写的用例挖出来的:夹具里给了一条带旧偏移的活会话,算出来的值被盖成了旧值。)
      if (e.slug) {
        try { if (fs.existsSync(path.join(require('./paths').CLAUDE_PROJECTS, e.slug, k + '.jsonl'))) continue; } catch {}
      }
      cur[k] = e; added++;
    }
  }
  if (added) { try { console.warn('[usage] 从备份里补回 ' + added + ' 个账本条目(它们的转录已经不在盘上了)'); } catch {} }
  return added;
}
function load() {
  const fp = require('./paths').USAGE_CACHE;
  const fresh = (!cache || cachePath !== fp);
  // 上次读失败了,而且已经过了重试间隔 → 再读一次。读得出来就把盘上那份当底、
  // 本程算出来的覆在上面(parseNew 对新条目是**从 0 整份重算**的,所以内存里这几条是完整值,
  // 不是增量,直接覆盖是安全的),然后解锁。
  const retry = (!fresh && !loadOk && lockedAt > 0 && (Date.now() - lockedAt) > reloadRetryMs());
  if (fresh || retry) {
    cachePath = fp;
    if (fresh) { writeLocked = false; lastBakAt = 0; loadOk = true; lockedAt = 0; badSig = ''; }   // 换了账本路径 → 这一份还没备份过
    const mine = retry ? cache : null;
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not-an-object');
      cache = mine ? Object.assign(j, mine) : j;
      mergeBackups(fp, cache);     // 盘上这份可能是损坏后重建的残本,把备份里多出来的条目补回来
      if (retry) {
        writeLocked = false; loadOk = true; lockedAt = 0;
        try { console.warn('[usage] 账本重新读出来了,恢复记账'); } catch {}
      }
    } catch (err) {
      if (!mine) {
        cache = {};                  // 重试又失败 → 内存里那份继续用,别清空
        // ⚠️ 这里才是真正丢数据的那一刻:账本读不出来 → 从零开始 → 孤儿条目永久消失。
        // 趁现在从备份里把它们捞回来(第十轮验收 P1-1 的根因)。
        mergeBackups(fp, cache);
      }
      loadOk = false;
      lockedAt = Date.now();
      if (!(err && err.code === 'ENOENT')) {
        // ⚠️ 「已经留过证据」要认**这一份文件**,不能只是个布尔值。
        // 两次读失败之间盘上那份可能已经被换掉 —— 典型:他看到数字不对,手动把 .bak 拷回来,
        // 而这一刻文件仍然读不出来(占用还没过去)。布尔值会让第二拍既不给新内容留证据、
        // 又因为旧标记解锁 → 把他刚恢复的好数据覆盖掉。第八轮验收 P3-3。
        // 签名用 size + mtimeMs:够区分「换了一份」,又不用把坏文件整份读进来。
        let sig = '';
        try { const s = fs.statSync(fp); sig = s.size + ':' + s.mtimeMs; }
        catch { sig = 'statfail'; }   // ⚠️ 不能留空:空串会让下面的 saved 永远为假 → 每次重试都重拷一份证据
                                      // (第九轮验收 P2-3 实测 6 拍 6 份;生产节奏约 27MB/小时)
        // sig 现在恒非空(statSync 失败也会落成 'statfail'),所以不用再判空(第十轮 P3-2)。
        let saved = (badSig === sig);
        if (!saved) {
          try {
            // ⚠️ 带随机后缀:时间戳只到秒,同一秒内第二份会把第一份(往往是最值钱的原件)顶掉,
            // 而日志两次都说「已另存」—— 在这条路上说假话(第十轮验收 P3-1)。
            const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
            const to = fp + '.bad-' + ts + '-' + Math.random().toString(36).slice(2, 6);
            fs.copyFileSync(fp, to);
            saved = true; badSig = sig;
            try { console.warn('[usage] 账本读不出来,已另存证据副本: ' + to); } catch {}
          } catch {}
        }
        // ⚠️ 这里必须是**赋值**,不能是「只置位」的 if (!saved) writeLocked = true。
        // 锁的条件是「**这一刻**还没留下证据」,不是「曾经没留下过」—— 这正是上面那段注释
        // (「存成功了才允许继续写」)的字面意思,而只置位的写法实现不出来:
        // 第 1 拍 EBUSY + 拷贝同错 → 锁死;第 2 拍读还是失败(换成永久性的 EIO/坏块),
        // 但这次**拷成功了** → 证据安全落地,而锁不解 → 以后每拍都因为「已留过证据」跳过拷贝
        // → 锁永远挂着 → 整程一个字节都不落盘。和 P1-1 完全同一个后果。
        // 第七轮验收 P1-1(实测:证据副本已存,盘上账本仍是读不出来的原件,一个字节没写进去)。
        writeLocked = !saved;
        // ⚠️ 损坏发生过 → 以后的滚动备份**换一个槽**(.bak2),原来那份好 .bak 一个字节不动。
        // 为什么不能只靠 loadOk:它只管「损坏事件进行中」。事件里我们把一份**薄账本**
        // (cache={},只有当前这几个会话)原子地写了上去;60 秒后重试读回来的正是我们自己写的那份,
        // 读得通 → loadOk=true → 备份解禁 → 立刻把薄账本拷成 .bak,把最后一份好数据顶掉。
        // 几个月的累计从「两份好的」变成「零份好的」,只剩一个 .bad-*(第六轮验收 P2-2,实测 200 条掉到 1 条)。
        // 为什么不是「冻到这一程结束」:那会让恢复后重建的账本一整天一份备份都没有,
        // 再坏一次什么都不剩(第七轮验收 P2-2)。换槽同时满足两头。
        // ⚠️ 但**换槽只管得了本进程** —— 第八轮验收 P1-1:重启一次这个标记就没了,
        // 薄账本是合法 JSON,下一程读得通就又往 .bak 上写。真正跨进程兜底的是
        // writeCache 里那道**体量理智检查**(盘上这份比已有 .bak 小一半就改写 .bak2)。
        // 第七轮我在这儿写过「文件被删这条路压根没有要保护的旧 .bak」—— 那句是错的,
        // 第八轮实测:他机器上 .bak 就在那儿(463,274 字节全量),而且是仅剩的好数据。
        try { console.warn('[usage] 账本读不出来(' + (err && err.code || err && err.message) + ')' + (saved ? ',证据已另存(路径见上一行)' : ',锁死写入以免覆盖') + ';账本目录: ' + path.dirname(fp)); } catch {}
      } else {
        // 文件真的不存在:正常,照常写,也照常备份自己写出来的那份。
        // ⚠️ writeLocked / badSig 必须一起归零(badSig 清不清其实无所谓 —— loadOk=true 之后 load() 不再读盘,
        // 「读失败(EBUSY)→ .bad-* 也拷不出来 → writeLocked=true」之后那个文件被删掉
        // (杀毒隔离就是直接删,或者他看到警告自己删了那份坏账本),
        // 下一拍重试读到 ENOENT → 这里把 loadOk 置回 true、lockedAt 清零,
        // 于是 retry 的前提 `!loadOk && lockedAt > 0` 永远不成立、fresh 也不成立
        // (cache 非空)→ load() 再也进不来 → writeLocked 永远挂着 → **整程一个字节都不落盘**,
        // 唯一提示是一条他看不见的 console.warn。第六轮验收 P1-1,实测五拍全没落盘。
        // 本程不会有第二次事件;写上是为了让这一串状态的清理清单保持完整)。漏了 writeLocked 的话:
        loadOk = true; lockedAt = 0; writeLocked = false; badSig = '';
      }
    }
  }
  return cache;
}
// ⚠️ 必须原子写(临时文件 + fsync + rename)。裸 writeFileSync 写一半被强杀/断电,
// 账本就半截了;load() 的 catch 会把它当空账本,下一次保存直接把 {} 写回去 ——
// 几个月的累计用量(222 个会话、小时级分布)一次没,而且没有备份。
// 项目里本来就有这个工具(lib/atomic-json.js),main.js 写 agent 配置和任务文件早就在用了,
// 偏偏最要紧的账本没用。
// ⚠️ 别信「projects.json / session-titles.json 都有 .bak」这种说法 —— 我第八轮在这儿写过,是错的:
// 那两个文件在代码里**完全没有备份**(lib/data.js 用裸 writeFileSync,连原子写都没有);
// AppData 里那些 .bak-* 是人工/历史会话临时拷的一次性文件,三种互不相同的命名风格。
// 也就是说账本这套(原子写 + 两个备份槽)已经是这个项目里最强的一份,没有现成范本可照抄。
// 拷一份备份。⚠️ 走 tmp + rename:账本本身坚持原子写,而「最后一道防线」的备份原来是裸
// copyFileSync —— 磁盘满 / 中途被强杀就留下半截的 .bak,正是「好备份被更差的数据顶掉」那一族
// (第九轮验收 P2-2)。rename 失败就把 tmp 清掉,目标文件保持原样。
function bakCopy(fp, slot) {
  const to = fp + slot, tmp = to + '.tmp';
  try {
    fs.copyFileSync(fp, tmp);
    fs.renameSync(tmp, to);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    try { console.warn('[usage] 备份写不进去(' + (e && e.code || e && e.message) + '): ' + to); } catch {}
    return false;
  }
}
function writeCache(fp) {
  if (writeLocked) return;            // 读失败且没留下证据 → 绝不覆盖(见 load)
  // 还没 load 过就别写:JSON.stringify(null) 会把账本原子地写成 "null",
  // 下一次 load 认定损坏 → 走整条损坏流程。现在 main.js 里没有 load 之前调 saveNow 的地方,
  // 所以打不着;但这是一行的事,封死比记着「以后别那么调」可靠。第六轮验收 P3-4。
  if (!cache) return;
  // 滚动备份:账本只有 260KB,十分钟留一份,代价可以忽略。
  // 原子写只保证「不会写出半截文件」,它救不了「写进去的内容本身就是空的」。
  // ⚠️ 必须 loadOk:备份的源是**盘上那份**,而「读失败」那条路恰恰是盘上那份已经坏了的时候才走到的。
  // 不加这个条件,每次因损坏而恢复都必然把上一程留下的好 .bak 覆盖成坏数据
  // —— 坏的两份、好的零份,这道防线在它唯一该起作用的场景里自己失效(第五轮验收 P1-1 实测)。
  //
  // 两个槽,职责写死,**不靠任何进程内状态判断该写哪个**:
  //   · `.bak`  = **高水位槽**:只在「盘上这份不比它小」时刷新 → 永远是见过的最全的一份;
  //   · `.bak2` = **近期槽**:每 bakEveryMs() 刷一次(默认十分钟),拿到的是最新状态(可能比 .bak 小)。
  // 恢复故事因此是明确的:**要最全的拿 .bak,要最新的拿 .bak2**(文档「常见问题」里写了)。
  //
  // 为什么走到这个设计 —— 前面四轮全栽在同一个形状上「好备份被更差的数据盖掉」:
  //   第五轮:备份源是盘上那份,而读失败那条路上盘上那份已经坏了 → 加 loadOk;
  //   第六轮:事件结束后重试读回的是我们自己写的薄账本(读得通)→ 加「损坏过就换槽」;
  //   第七轮:「冻结备份」是净损失(重建的账本一整天零备份)→ 换槽;
  //   第八轮:换槽的标记只活在本进程,重启一次 .bak 就被薄账本顶掉 → 加体量理智检查;
  //   第九轮:体量闸挂在**槽位名**上 —— corrupted 为真时 slot 一上来就是 .bak2,整道闸被跳过,
  //           `.bak2` 里的好数据照样被无条件覆盖;而这个前提状态正是这道闸自己造出来的
  //           (账本一旦合法缩到 .bak 的一半以下,每次备份都改写 .bak2 并吃掉 lastBakAt
  //            → .bak 从此永不刷新 → 当前数据唯一的副本只在 .bak2 里)。实测两进程复现。
  // ⚠️ 而且「账本只增不减」这个前提**本身是错的**,还错在这道闸唯一该管的那个场景里:
  //   他账本 229 条,只有 194 条还有转录在盘上;另外 35 条孤儿占 12.6% 体量、
  //   装着**全部累计 token 的 17.0%**(最老的转录只到 2026-08-19,而账本数据跨 164 天)。
  //   任何一次损坏之后 cache={},warmup 只能按还在盘上的转录重建 → 约为现在的 **86%**,
  //   0.86 ≥ 0.5 → 闸不触发 → 仅剩的全量 .bak 被 86% 那份顶掉(第九轮验收 P1-2 实测)。
  //   另外两条会缩的路:变短重算里的 `entry.h = {}`(单条最多 417 个小时桶,最大的一条
  //   32,040 字节 = 全文件 6.9%)、`clearHold` 每条删两个字段。
  //   **结论:任何单一阈值都解不了 —— 收紧会被正常抖动误判,放松就放过 14% 的缩水。**
  //   高水位槽不需要阈值:它只问「这份是不是不比我见过的最全那份小」。
  try {
    if (loadOk && Date.now() - lastBakAt > bakEveryMs()) {
      const now = fs.statSync(fp).size;
      if (now > 2) {
        // 高水位槽:量的是**真正要被覆盖的那个文件**,不是槽位名(第九轮 P1-1 的根因)
        let hiOk = false;
        try {
          // ⚠️ 判据是**键集合超集**,不是字节数。字节数两头都错(第十轮验收 P1-1 实测):
          //   · 「更大但更差」:损坏后重建的残本只要熬过约 25 天,靠新用量就能把字节数长回去
          //     (孤儿 66,223 字节 ÷ 平均 2,678 字节/天 ≈ 24.7 天)→ 放行覆盖 → 17.4B token
          //     从每一个副本里消失。回填给 194 条各加 ac/acPre/lastCtx 更会缩短这个窗口。
          //   · 「更好但更小」:变短重算清掉一条的 h(最大一条 32,040 字节 = 6.9%)之后,
          //     键集合完整、数字最新,却比三个月前那份小 → .bak 永远学不到它。
          //   换键数/token 总和也救不了(算过:都是 26~28 天同一个数量级)。
          //   只有「集合包含」不会误放行。463KB 每十分钟 parse 一次,成本可忽略。
          const oldRaw = fs.readFileSync(fp + '.bak', 'utf8');
          let oldJ = null;
          try { oldJ = JSON.parse(oldRaw); } catch { oldJ = null; }
          if (!oldJ || typeof oldJ !== 'object' || Array.isArray(oldJ)) hiOk = true;   // 旧的那份已经坏了,不值得保
          else { hiOk = true; for (const k in oldJ) { if (!cache[k]) { hiOk = false; break; } } }
        } catch (e) {
          // ⚠️ 失败即关闸,不是失败即放行。这个模块的立论就是「Windows 上杀毒/备份软件
          // 会短暂占用这个目录的文件」—— 原来那个裸 catch {} 把 EBUSY/EPERM/EIO 一起吞了,
          // `.bak` 正被占着的那一刻这道闸悄悄消失,薄账本直接覆盖好 .bak(第九轮 P2-1)。
          // 只有「它确实不存在」才算放行。
          hiOk = (e && e.code === 'ENOENT');
        }
        let okHi = false;
        if (hiOk) okHi = bakCopy(fp, '.bak');
        else try { console.warn('[usage] 账本比历史最全那份小,这一拍只刷新 ' + fp + '.bak2;最全的一份仍在 ' + fp + '.bak'); } catch {}
        const okNew = bakCopy(fp, '.bak2');     // 近期槽照刷
        // ⚠️ 只有真拷成了才吃掉节流。两个槽都失败(杀毒扫一下目录就会这样,
        // 而这个模块的整个立论就是这个)却照样记时间,等于白送十分钟空窗;
        // 占用有周期性的话备份会长期饿死(第十轮验收 P2-2)。
        if (okHi || okNew) lastBakAt = Date.now();
      }
    }
  } catch (e) {
    // ⚠️ 别静默:statSync(fp) 失败会让整段备份消失,而本文件其它失败路径全都喊一声(第十轮 P3-5)。
    try { console.warn('[usage] 这一拍没能备份(' + (e && e.code || e && e.message) + ')'); } catch {}
  }
  // 只走原子写。原来还留了一条裸 writeFileSync 退路,那条路和上面那段注释自相矛盾:
  // Windows 上 rename 失败最常见的原因是目标被别的句柄占着(EPERM),而 open('w') 这时往往成功
  // —— 于是退路会把账本**截断后非原子地重写**,正是禁止的那件事。写不进去就跳过这一拍,
  // 内存里的 cache 还在,下一拍(800ms 后)再试。第五轮验收 P3-2。
  // ⚠️ 别静默。空 catch 的话写不进去界面上一个字都没有,而「下一拍再试」只在**后面还有人调 save()**
  // 时才成立 —— 他把客户端放着不动、或者正好退出 App,就没有下一拍了。
  // 所以这里至少要喊一声(主进程日志),退出前再强制落一次(见 main.js 的 before-quit)。第六轮验收 P2-3。
  try { require('./atomic-json').writeJsonAtomic(fp, cache); }
  catch (e) { try { console.warn('[usage] 账本写不进去(' + (e && e.code || e && e.message) + '),这一拍跳过,内存里的还在'); } catch {} }
}
function save() {
  const fp = cachePath || require('./paths').USAGE_CACHE;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeCache(fp), 800);
}
// 立刻落盘。给长任务用:回填要跑一两分钟,每个文件完成都 save() 一次的话
// 800ms 防抖会被一直重置,中途退出 App 就全白跑了,下次启动还得重扫一遍。
function saveNow() {
  const fp = cachePath || require('./paths').USAGE_CACHE;
  clearTimeout(saveTimer);
  writeCache(fp);
}
// 同一个会话目录会被多个项目共用:会话目录名是「路径里非 [A-Za-z0-9-] 的字符全换成 '-'」,
// 中文一字一杠 —— 2026-11-10 实测:49 个项目折叠成 37 个目录,5 个 slug 被多个项目共用,
// **涉及 17 个项目**(最狠的一个被 8 个项目共用),可省掉的重复读是 12 份
// (「17 个项目」和「12 份重复」不是一件事,别混);不去重的话 186 份转录要排成 924 份
// (实测多读 9.57GiB ≈ 10.3GB / 多花 70 秒)。
// ⚠️ 这几个数都是**那一天的快照**,他加项目、转录变长就都会变。
// 2026-11-11 重新量过:50 个项目 → 38 个目录,共用 slug 仍是 5 个 / 涉及 17 个项目 /
// 最狠的仍被 8 个共用 / 可省 12 份(结构没变),但份数和体积已经是 **193 → 954 份、多读 9.63GiB**。
// 去重这件事本身不看数量,所以代码不用动;但引用这些数字时**每个数都要带日期**
// —— 上一版只更新了 7 个数里的 2 个,第六轮验收当场点出来了。
function uniqDirs(dirs) {
  const seen = new Set(), out = [];
  for (const d of (dirs || [])) { const k = path.resolve(d).toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(d); }
  return out;
}
const pad = n => String(n).padStart(2, '0');
function lhk(d) { // 本地小时键 2026-07-27T14
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours());
}
function lday(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

// 一次最多读这么多字节。原来是「整段增量一次 Buffer.alloc + 一次 toString」——
// 他最大的转录 730,420,457 字节,已经超过 Node 字符串上限(536,870,888),
// entry.size 一旦被清零(账本坏掉重来、文件变小走 shrink 分支、换机),
// toString 直接抛 ERR_STRING_TOO_LONG,被 sessionUsage 的 catch 吞掉 →
// 这个会话的用量永久记不进来,而且每次启动都要白卡 2.3 秒再抛一次(第四轮验收 P1-2 实测)。
// 分块之后单次内存和单次阻塞都有上限;跨块的半行和被切开的多字节字符分别由
// rest 和 StringDecoder 接住(别用 buf.toString(start,end) 自己切,中文会切出乱码)。
function parseChunk() { const v = Number(process.env.HUB_PARSE_CHUNK); return (v > 0) ? v : 32 * 1024 * 1024; }

// 半行扣着最多扣这么久;超过就当它是永久的坏尾巴(写到一半被强杀),消费掉,别每拍白读。
// 可用 HUB_HOLD_MAX_MS 覆盖(测试用)。第七轮验收 P2-1:判据必须带时间,不能只看拍数。
function holdMaxMs() { const v = Number(process.env.HUB_HOLD_MAX_MS); return (v > 0) ? v : 60 * 1000; }
// tailHold / tailAt 这两个字段只在「扣着半行」时才有意义,清掉就别留在账本里占地方
// (JSON.stringify 会把 0 也写进去,229 个条目各多一个字段)。
function clearHold(e) { delete e.tailHold; delete e.tailAt; }
function parseNew(fp, entry, budgetBytes) {
  const st = fs.statSync(fp);
  if (st.size <= entry.size) { if (st.size < entry.size) { entry.size = 0; entry.in = entry.out = entry.cw = entry.cr = 0; entry.h = {}; entry.ac = entry.acPre = entry.lastCtx = 0; clearHold(entry); } else return true; }   // ⚠️ tailHold/tailAt 跟着一起清:这是「这个条目从头开始」的完整清单,漏字段正是第 37 条坑那个坑。/* ⚠️ 这一句**不是**冗余。我第七轮判它「等价」是错的,漏了 done === false 那条早退:light 模式下「变短 + 单拍预算用光」时 return false 发生在循环内部,末尾那段「推到哪」被整个跳过 —— 旧记号就活过了这次调用,还会被 saveNow() 写进账本、跨进程存活(指向一份已经不存在的转录)。第八轮验收反驳 claim(a),已补用例「light 延后那条路上变短重算」。 */   // 没有新字节 = 已经读完了
  const handleLine = (ln) => {
    // 顺手记下「这个会话真实压在哪」—— 官方每次压缩都往转录里写一条 compact_boundary。
    // 记的不是 preTokens(那是官方自己的口径),而是**压缩前最后一轮药丸会读到的那个数**,
    // 这才是能直接和顶栏读数比的量。实测两者差中位 0.36%、最大一次 20.9%(77 次里)。
    if (ln.includes('compact_boundary')) {
      let e2; try { e2 = JSON.parse(ln); } catch { e2 = null; }
      const m = e2 && e2.type === 'system' && e2.subtype === 'compact_boundary' && e2.compactMetadata;
      if (m && m.trigger === 'auto' && entry.lastCtx > 0) {
        entry.ac = entry.lastCtx;                  // 药丸口径的真实压缩点
        entry.acPre = m.preTokens || 0;            // 官方口径,留着对账
      }
      return;
    }
    if (!ln.includes('"usage"') || !ln.includes('"assistant"')) return;
    let e; try { e = JSON.parse(ln); } catch { return; }
    if (!e || e.type !== 'assistant') return;
    const u = e.message && e.message.usage;
    if (!u) return;
    const inT = u.input_tokens || 0, outT = u.output_tokens || 0,
      cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
    // 跨 chunk 也要留住,所以存在 entry 上(增量解析一次只看新追加的那段字节)。
    // ⚠️ 0 不许写进去:真实转录里有 354 行 assistant 的 usage 全是 0,其中 4 行恰好紧贴在
    // compact_boundary 前面 —— 无条件写 0 会让下面 `entry.lastCtx > 0` 不成立,
    // 把这次压缩的实测点整条丢掉(实测 77 次自动压缩丢 4 次,3 次都在 99.5 万那一档)。
    // 回填那边本来就跳过 0,两处必须同一个口径。
    const tot = inT + cr + cw;
    if (tot) entry.lastCtx = tot;
    entry.in += inT; entry.out += outT; entry.cw += cw; entry.cr += cr;
    const ts = e.timestamp ? new Date(e.timestamp) : null;
    if (ts && !isNaN(ts.getTime())) {
      const hk = lhk(ts);
      const model = String((e.message.model || '?')).replace(/^claude-/, '').slice(0, 24);
      const b = entry.h[hk] || (entry.h[hk] = {});
      b[model] = (b[model] || 0) + inT + cw + outT; // 处理量口径(不含便宜的缓存读)
      b._out = (b._out || 0) + outT;
    }
  };
  const { StringDecoder } = require('string_decoder');
  const dec = new StringDecoder('utf8');
  const fd = fs.openSync(fp, 'r');
  let done = false;
  // 这三个要在 try 外面:下面决定「entry.size 推到哪」时还得用。
  let committed = entry.size;   // 已经**算进 entry** 的字节数(一行一提交)
  let tailOk = true;            // 末尾那一行是不是一条完整记录
  let shortRead = false;        // readSync 读出 0 字节(stat 之后文件被截短)
  try {
    let pos = entry.size, rest = '';
    const start = pos;
    // ⚠️ 必须一行一提交。分块之前是「整段 toString 再逐行累加」,toString 是在**任何累加之前**抛的,
    // 所以老代码抛了就一个数都没加、下一拍从头重来、不会双计。分块把「解析」和「提交」交错了:
    // 循环中途 readSync 抛(EIO/EBUSY/网络盘),异常被 sessionUsage 的 catch 吞掉,
    // 已经加进 entry 的那几块留着、entry.size 还是旧值 → 下一拍从同一个偏移重读 = **重复计数**
    // (实测 1200 字节的文件多算 25%,方向是把用量**报高**)。第五轮验收 P2-2。
    // 消费字节数自己数:byteLength(ln) + 1 对 LF 和 CRLF 都准('\r' 本来就留在 ln 里),
    // 这样也绕开了「StringDecoder 内部还攒着 1~3 个字节」这件事 —— 那半个字符还没进 rest,
    // 用 pos 减 rest 的字节数会把它当成已消费,下一拍从字符中间开始读,那一行就废了。
    committed = pos;
    const budget = (budgetBytes > 0) ? budgetBytes : Infinity;   // 单拍字节预算,0/不传 = 不限
    // 单拍预算也要管住**块大小**,否则预算的粒度就是块大小:默认块 32MB、预算 8MB 时,
    // 25MB 的文件会被一个块一次读完,预算等于没生效(补变异时这条用例当场抓到)。
    const cap = Math.min(parseChunk(), budget, Math.max(1, st.size - pos));
    const buf = Buffer.alloc(cap);
    while (pos < st.size) {
      const want = Math.min(cap, st.size - pos);
      const got = fs.readSync(fd, buf, 0, want, pos);
      if (got <= 0) { shortRead = true; break; }   // stat 之后被截短了,见下面「推到哪」
      pos += got;
      const txt = rest + dec.write(buf.subarray(0, got));
      const parts = txt.split('\n');
      rest = parts.pop();            // 最后一截可能是半行,留给下一块
      for (const ln of parts) {
        handleLine(ln);
        // ⚠️ 这个等式只在**输入是合法 UTF-8** 时成立:非法字节会被 StringDecoder 换成
        // U+FFFD(3 字节),committed 就多推 2 字节、越过没读过的数据,下一拍从行中间开始,那一行报废。
        // 实测他 212 份顶层转录 0 份含非法 UTF-8 序列,所以现在打不着(第六轮验收 P3-2)。
        committed += Buffer.byteLength(ln, 'utf8') + 1;
        entry.size = committed;      // 抛在这之后 → 下一拍从这里接着读,不重不漏
      }
      // 单拍读够了就交回事件循环:他最大那份转录 730MB 整份解析要 9 秒,
      // 全压在一拍里主进程(含终端 IO)整个冻住。剩下的由调用方下一拍接着读。
      // ⚠️ 只许在**行边界**上交回去(committed > start)。否则单行比预算还长时
      // 一个字节都提交不了、entry.size 不动,下一拍从同一个偏移再读 —— 原地打转,
      // setTimeout(step, 0) 把主进程烧满。实测他 212 份转录最长的一行 5.33MB,
      // 还没越过 8MB 这道线,但余量只有 1.5 倍:贴一张大图或一次大的工具输出就过线。
      // 这种情况下宁可这一拍多读几块(内存上限 = 那一行本身,无法再省),也不能不前进。
      if (committed > start && pos - start >= budget && pos < st.size) return false;
    }
    rest += dec.end();
    if (rest) {
      // 文件末尾没有换行符的那一行。⚠️ 它也可能是官方**正在写的半行**:
      // 大的 tool_result 行有好几 MB(他最长的一行 5.33MB),appendFile 会被拆成多次 write,
      // 读者完全能看到半行。半行 JSON.parse 必然失败、一个数都不计,
      // 而 entry.size 要是照样推到 st.size,这一行补全之后下一拍从它后面开始读
      // —— 这一轮的 in/out/cw/cr **永久不计**,lastCtx 停在上一轮;
      // 半行恰好是 compact_boundary 的话,这次压缩的实测点也丢。
      // 第六轮验收 P2-1(实测少算 5 万 token、lastCtx 停在旧值)。
      // 所以:尾巴不是完整 JSON 就不消费它,下一拍重读。
      try { JSON.parse(rest); } catch { tailOk = false; }
      // ⚠️ 短读(stat 之后文件被截短)时不许把 rest 算进去:下面 shortRead 那一支会把偏移
      // 退回 rest 之前,算了就等于下一拍重读同一条记录 = **报高**。第七轮验收 P2-8。
      if (tailOk && !shortRead) handleLine(rest);
    }
    done = true;
  } finally { try { fs.closeSync(fd); } catch {} }   // 包一层:closeSync 抛(EBADF/网络盘)不该把异常顶出去,三处尾读口径要一致(第八轮 P3-5)
  // entry.size 推到哪:只推到「真的算进去了」的位置。
  //  · 尾巴完整、而且没读短 → 推到 st.size
  //  · 尾巴是半行 → 只推到 committed,下一拍把那一行整条重读
  //    (但如果上一拍就在**同一个大小**上扣着没动,说明它不是「正在写」而是永久的坏尾巴
  //     —— 比如写到一半被强杀 —— 那就消费掉它,别每一拍都回头白读)
  //  · readSync 读出 0 字节(stat 之后被截短)→ 同样只推到 committed,
  //    推到那个过期的 st.size 会把没读过的字节跳过去(第六轮验收 P3-3)
  if (done) {
    if (tailOk && !shortRead) { entry.size = st.size; clearHold(entry); }
    else if (tailOk && shortRead) { entry.size = committed; }
    // ⚠️ 「永久坏尾巴」的判据必须带**时间**,不能只看「上一拍也扣在这个大小」。
    // 生产里连续两次 parseNew 可以只隔几毫秒:改收尾线 → ctxRemind 变 → ctxCache 的 key 变
    // (key 里带 remindAt)→ 2 秒缓存被绕过 → 立刻再读一次;切项目/切会话/绑会话/关终端同样会立刻重读。
    // 按拍数判的话,正在写的那半行会在 4 毫秒内被当成「永久坏尾」吞掉 ——
    // 那一轮的用量永久不计,而且 lastCtx 停在旧值、紧随其后的 compact_boundary 会把一个
    // **偏小的假实测点**写进 entry.ac,污染校准唯一的长期数据通道。
    // 第七轮验收 P2-1(实测两次相隔 4ms:in 应 501000 实得 1000,ac 应 500000 实得 1000)。
    // ⚠️ 带上 !shortRead:短读时 st.size 是个**过期的大值**,
    // 让这一支消费掉就等于把从未读到的字节跳过去(第八轮验收 P3-1)。
    else if (!shortRead && entry.tailHold === st.size && entry.tailAt > 0 && Date.now() - entry.tailAt > holdMaxMs()) {
      entry.size = st.size; clearHold(entry);
    }
    else {
      entry.size = committed;
      if (entry.tailHold !== st.size) { entry.tailHold = st.size; entry.tailAt = Date.now(); }
    }
  }
  return done;
}

// light=true 时单拍不解析超过 8MB 的增量(别卡住 UI),但**必须安排兜底**:
// delta 是「距上次成功解析攒下的全部字节」,跳过并不推进 entry.size,
// 所以下一拍只会更大 —— 第四轮验收实测:闸一旦关上就永远打不开,
// 那个会话的实测压缩点和用量从此停更(他一个会话一天就写 85MB,约 34MB/小时,
// 8MB 这道闸几小时内必被某一拍跨过),而 warmup 只在启动后 3 秒跑一次,全程没有第二次。
// 所以超限时改成「下一个事件循环接着读」:延后不卡当前这次 IPC 应答;
// 而且按 LIGHT_MAX 的单拍预算分多拍读完 —— 分块只封住了**内存**,没封住**阻塞时长**,
// 他那份 730MB 整份解析要 9 秒,全压在一拍里主进程(含终端 IO)整个冻住(第五轮验收 P2-3)。
const LIGHT_MAX = 8 * 1024 * 1024;
const catchingUp = new Set();
function sessionUsage(dir, sid, light) {
  const c = load();
  const fp = path.join(dir, sid + '.jsonl');
  let st; try { st = fs.statSync(fp); } catch { return null; }
  let entry = c[sid];
  // 新条目一上来就带 ac:0 —— 它既是「这个会话还没测到压缩点」,也是「不用再回填它了」的标记:
  // parseNew 会从第 0 字节整读一遍,有压缩自己就记下来了,回填没必要再碰。
  if (!entry) entry = c[sid] = { size: 0, in: 0, out: 0, cw: 0, cr: 0, h: {}, slug: path.basename(dir), ac: 0 };
  entry.slug = path.basename(dir);
  const delta = st.size - entry.size;
  // ⚠️ 必须用 !== 0 而不是 > 0:转录变短(会话被重建、从回收站恢复、外部工具改过)时
  // delta 是负的,> 0 这道闸会把它整个挡在外面 —— parseNew 里那段「变短就整份重算」
  // 于是成了死代码,账本会永远留着旧的累计和一个已经不存在的实测压缩点(第四轮补测时发现)。
  if (delta !== 0) {
    // 要读多少字节:正常追加就是 delta;变短了是「整份重算」,代价是**整个新文件**。
    // ⚠️ 不能只看 delta:变短时 delta 是负的,必然小于闸门 → 恒走同步那一支,
    // 于是 liveContext(15 秒一跳的 IPC)里会当场同步重读整个文件,8MB 这道闸形同虚设
    // (实测 9.7MB 截短到 2.9MB 时同一拍内读完;换成他那份 730MB 就是主进程冻 9 秒)。第五轮验收 P2-3。
    const cost = (delta < 0) ? st.size : delta;
    if (!light || cost < LIGHT_MAX) {
      try { parseNew(fp, entry); save(); } catch {}
    } else if (!catchingUp.has(fp)) {
      catchingUp.add(fp);
      // 分多拍读完:每拍最多 LIGHT_MAX 字节(约 0.1 秒),没读完就再排一拍。
      // entry.size 是一行一提交的,所以中断在哪都接得上(见 parseNew)。
      const step = () => {
        const before = entry.size;
        let fin = true;
        try { fin = parseNew(fp, entry, LIGHT_MAX); save(); } catch {}
        // ⚠️ 没前进就别再排下一拍。parseNew 现在保证「返回 false 时至少提交了一行」,
        // 但这道闸要留着:一旦哪天它又不前进了(改错、或者 readSync 一直读 0 字节),
        // setTimeout(step, 0) 会把主进程烧满 —— 补变异时第 10 条当场让测试进程永不退出,
        // 就是这条路。宁可这个会话这一程不更新,也不许让客户端转死。
        // 判据是「偏移变过没有」,不是「变大没有」:文件变短时 parseNew 会先把 entry.size
        // 归零再从头重算,那一拍的 8MB 比原来的 25MB 小 —— 按「变大」判会把正常的追赶
        // 当成卡住掐掉(我第一版就这么写错了,当场挂了「变短也要延后」那条用例)。
        // ⚠️ 这道闸**单独变异测不出来**:parseNew 现在保证「返回 false 必定提交过至少一行」,
        // 所以在出厂代码里它永不触发。这是**刻意保留的纵深防御**,不是漏测
        // (第六轮验收 P3-8 同意保留)。组合方向有覆盖:允许不提交就让出 → 用例会红。
        if (fin === false && entry.size !== before) { setTimeout(step, 0); return; }
        if (fin === false) {
          try { console.warn('[usage] 追赶没前进,停在 ' + entry.size + '/' + fp + ',等下次变化再试'); } catch {}
        }
        catchingUp.delete(fp);
      };
      setTimeout(step, 0);
    }
  }
  return entry;
}

// 回填每步之间留点间隔：它跑在启动后，正是他要开始干活的时候，warmup 那边用的也是 10ms。
const STEP_MS = 5;

// 一次性回填「实测压缩点」。
// 为什么需要:parseNew 是增量的,只看新追加的字节 —— 加上 compact_boundary 这段逻辑之前
// 已经解析完的会话(他机器上 222 个)永远不会自己补上这个数,校准功能等于是死的。
// 回填**只写 ac / acPre / lastCtx 三个字段**,不动 in/out/cw/cr,所以不会影响任何已有的用量统计。
// 用 readline 流式读:转录能到 730MB(实测最大 730,420,457 字节),而且跨 chunk 的
// UTF-8 字符交给它处理,不会读出乱码。
// 「只跑一次」靠的是每个条目自己的 ac 字段(新条目在 sessionUsage 里就带 ac:0),
// 不用全局标记 —— 全局标记会把「回填那一次不在 dirs 里的目录」永久排除在外
// (项目被移出再加回、或当时目录不存在),那些会话以后永远拿不到实测点。
function backfillCompactPoints(dirs, onDone) {
  const readline = require('readline');
  const c = load();
  const jobs = [];
  for (const dir of uniqDirs(dirs)) {
    let files = []; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const sid = f.replace(/\.jsonl$/, '');
      const e = c[sid];
      // 只补已经在账本里、而且还没扫过的;新会话交给 parseNew(它现在一上来就记)
      if (e && typeof e.ac !== 'number') jobs.push([dir, sid]);
    }
  }
  let i = 0, found = 0, didScan = 0;
  const nextFile = () => {
    if (i >= jobs.length) { saveNow(); if (onDone) onDone(found, jobs.length); return; }
    const [dir, sid] = jobs[i++];
    const e = c[sid];
    // 建队列之后才拿到实测点的(别的目录重名、或者 parseNew 抢先记上了)直接跳过,不重复读
    if (!e || typeof e.ac === 'number') return setTimeout(nextFile, 0);   // 跳过不读盘，不用留间隔
    let rl;
    try { rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, sid + '.jsonl')), crlfDelay: Infinity }); }
    catch { return setTimeout(nextFile, STEP_MS); }   // 打不开就下一个,别记成「扫过了没压过」
    let last = 0, ac = 0, acPre = 0, bad = false;
    rl.on('line', (ln) => {
      if (!ln) return;
      if (ln.includes('compact_boundary')) {
        let e2; try { e2 = JSON.parse(ln); } catch { return; }
        const m = e2 && e2.type === 'system' && e2.subtype === 'compact_boundary' && e2.compactMetadata;
        if (m && m.trigger === 'auto' && last > 0) { ac = last; acPre = m.preTokens || 0; }
        return;
      }
      if (!ln.includes('"usage"') || !ln.includes('"assistant"')) return;
      let e3; try { e3 = JSON.parse(ln); } catch { return; }
      if (!e3 || e3.type !== 'assistant' || !e3.message) return;
      const u = e3.message.usage;
      if (!u) return;
      const v = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (v) last = v;
    });
    const done = () => {
      // 读失败的不许写 ac —— 那等于把「读失败」记成「这个会话没压过」,以后再也不扫它
      if (e && !bad) {
        // ⚠️ 不许覆盖已经测到的点:这 80 秒里 parseNew 可能刚好记下一个新的压缩点,
        // 而它只看新追加的字节,那条 boundary 已经被消费过 —— 覆盖回 0 就是永久丢失
        if (!(typeof e.ac === 'number' && e.ac > 0)) {
          e.ac = ac; e.acPre = acPre;
          // lastCtx 只在它本来没有的时候补:那 20~70 秒里 parseNew 可能已经把它推到更新的位置,
          // 用这份流式快照盖回去,下一次压缩记下的实测点就会偏旧一轮(第四轮验收 P3)。
          if (!(e.lastCtx > 0)) e.lastCtx = last;
        }
        if (ac) found++;
        if (++didScan % 25 === 0) saveNow(); else save();   // 中途退出不许全白跑
      }
      setTimeout(nextFile, STEP_MS);   // 给磁盘留口气,别在他刚要干活的时候榨满
    };
    rl.on('close', done);
    rl.on('error', () => { bad = true; try { rl.close(); } catch {} });
  };
  nextFile();
}

// 后台全量预热:每个 tick 解析一个文件,不阻塞
function warmup(dirs, onDone) {
  const jobs = [];
  for (const dir of uniqDirs(dirs)) {   // 同一个会话目录被多个项目共用，不去重就把 186 份转录排成 924 份
    let files = []; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) jobs.push([dir, f.replace('.jsonl', '')]);
  }
  let i = 0;
  const step = () => {
    if (i >= jobs.length) { save(); if (onDone) onDone(); return; }
    const [d, sid] = jobs[i++];
    try { sessionUsage(d, sid, false); } catch {}
    setTimeout(step, 10);
  };
  step();
  return jobs.length;
}

// ⚠️ nowMs 只给测试用(默认走 Date.now())。原来这里写的是 new Date(),
// 于是「按小时/按天分桶」这一整块**根本没法确定性地测** —— 打桩 Date.now 对 new Date() 无效。
// 后果是最要紧的那条变异(小时桶从累加改成每行覆盖,🔥 胶囊/今日/近 7 天全只剩每小时最后一条)
// 可以全绿通过。第七轮验收 P2-5。
function aggregates(nowMs) {
  const c = load();
  const now = new Date(nowMs || Date.now());
  const keys5 = new Set(); for (let i = 0; i < 5; i++) keys5.add(lhk(new Date(now.getTime() - i * 3600e3)));
  const today = lday(now);
  const days7 = new Set(); for (let i = 0; i < 7; i++) days7.add(lday(new Date(now.getTime() - i * 86400e3)));
  const agg = { last5h: { proc: 0, out: 0 }, today: { proc: 0, out: 0 }, week: { proc: 0, out: 0 }, models: {}, top: [] };
  for (const sid in c) {
    const e = c[sid];
    if (!e || !e.h) continue;
    let sidToday = 0;
    for (const hk in e.h) {
      const b = e.h[hk];
      let proc = 0;
      for (const m in b) { if (m === '_out') continue; proc += b[m]; }
      const out = b._out || 0;
      const day = hk.slice(0, 10);
      if (keys5.has(hk)) { agg.last5h.proc += proc; agg.last5h.out += out; }
      if (day === today) {
        agg.today.proc += proc; agg.today.out += out; sidToday += proc;
        for (const m in b) { if (m !== '_out') agg.models[m] = (agg.models[m] || 0) + b[m]; }
      }
      if (days7.has(day)) { agg.week.proc += proc; agg.week.out += out; }
    }
    if (sidToday > 0) agg.top.push({ sid: sid.slice(0, 8), slug: e.slug || '', proc: sidToday });
  }
  agg.top.sort((a, b) => b.proc - a.proc);
  agg.top = agg.top.slice(0, 6);
  agg.modelList = Object.entries(agg.models).map(([m, v]) => ({ m, proc: v })).sort((a, b) => b.proc - a.proc);
  return agg;
}

// 单会话逐轮明细:每条 assistant 回复一行(时间/模型/各类token)
function sessionTimeline(dir, sid, limit) {
  const fp = path.join(dir, sid + '.jsonl');
  const out = [];
  let lines = [];
  try {
    const st = fs.statSync(fp);
    const take = Math.min(st.size, 40 * 1024 * 1024);
    // ⚠️ closeSync 必须在 finally 里。写在 try 内部的话,readSync 一抛(EIO/EBUSY/网络盘、
    // 或者转录正被别的进程占着)句柄就泄漏 —— 这个函数挂在界面操作上,句柄只增不减,
    // 攒到 EMFILE 客户端什么都读不出来。parseNew 本来是对的,这里和 scanCtxTail 两处同形代码
    // 当时漏改了(第七轮验收 P2-3,实测泄漏 250 个句柄、closeSync 零次)。
    // 另外 readSync 的返回值必须用上:文件在 statSync 之后变短时,buf 尾部那段没写满的零字节
    // 会被一起解析进去(lib/data.js 的 sessionTitle 本来就是对的,又是一处横向不一致,P3-6)。
    let fd = null, n = 0;
    const buf = Buffer.alloc(take);
    try {
      fd = fs.openSync(fp, 'r');
      n = fs.readSync(fd, buf, 0, take, st.size - take);
    } finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
    lines = buf.toString('utf8', 0, n).split('\n');
  } catch { return out; }
  let lastUser = '';
  for (const ln of lines) {
    if (!ln || ln[0] !== '{') continue;
    let e; try { e = JSON.parse(ln); } catch { continue; }
    if (!e || e.isSidechain || e.isMeta) continue;
    if (e.type === 'user') {
      const c = e.message && e.message.content;
      let t = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join(' ') : '');
      t = String(t).replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (t && t[0] !== '<') lastUser = t.slice(0, 60);
      continue;
    }
    if (e.type !== 'assistant') continue;
    const u = e.message && e.message.usage;
    if (!u) continue;
    const inT = u.input_tokens || 0, outT = u.output_tokens || 0,
      cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
    out.push({
      ts: e.timestamp || '', model: String(e.message.model || '').replace(/^claude-/, ''),
      in: inT, out: outT, cw, cr, total: inT + cw + outT, task: lastUser
    });
  }
  return out.slice(-(limit || 200)).reverse();
}

// 按项目(sessSlug)汇总累计 token
function totalsBySlug() {
  const c = load();
  const out = {};
  for (const sid in c) {
    const e = c[sid];
    if (!e || !e.slug) continue;
    out[e.slug] = (out[e.slug] || 0) + (e.in || 0) + (e.cw || 0) + (e.out || 0);
  }
  return out;
}

// 近 N 天每日消耗(趋势图用)
function dailySeries(days, nowMs) {
  const c = load();
  const map = {};
  const now = new Date(nowMs || Date.now());
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400e3);
    map[lday(d)] = { day: lday(d), proc: 0, out: 0 };
  }
  for (const sid in c) {
    const e = c[sid];
    if (!e || !e.h) continue;
    for (const hk in e.h) {
      const day = hk.slice(0, 10);
      if (!map[day]) continue;
      const b = e.h[hk];
      for (const m in b) { if (m !== '_out') map[day].proc += b[m]; }
      map[day].out += b._out || 0;
    }
  }
  return Object.values(map);
}

// 导出明细 CSV(按会话)
function exportRows() {
  const c = load();
  const lines = ['会话ID,项目目录,输入,缓存写,缓存读,输出,合计(输入+缓存写+输出)'];
  for (const sid in c) {
    const e = c[sid];
    if (!e) continue;
    const total = (e.in || 0) + (e.cw || 0) + (e.out || 0);
    if (!total) continue;
    lines.push([sid, e.slug || '', e.in || 0, e.cw || 0, e.cr || 0, e.out || 0, total].join(','));
  }
  return lines.join('\r\n');
}

// ===== 当前上下文占用(瞬时值,跟上面的累计记账是两回事,别混) =====
// 口径:最后一条 assistant 消息的 input_tokens + cache_read + cache_creation,
//      也就是这一轮真正喂给模型的上下文大小。累计用量是把每轮加起来,这里只要最后一轮。
// 只倒读文件尾部:会话转录能涨到几百 MB(实测最大 730MB),整文件读进来会卡住主进程
// —— 而且超过 512MB 之后 Node 连字符串都装不下(见上面 MAX_STRING_LENGTH 那段)。
const CTX_TAIL = 512 * 1024;
const CTX_TAIL_MAX = 8 * 1024 * 1024;   // 单行超过 512KB 时的兜底(贴了大段日志/大图的那一轮会这样)
const CTX_WIN_DEFAULT = 1000000;   // settings.json 没配 autoCompactWindow 时,官方默认 100 万
// 硬上限 = autoCompactWindow - 13000。来自 claude.exe:
//   var qan=13000; function AY(e,n){ let r=e-13000, ... return r }
//   官方 warn 档再往前 20000(w=S-20000)
const COMPACT_RESERVE = 13000;
// ⚠️ 但实测压缩**不在**这个硬上限上,会更早。
// 证据不是推断:转录里每次压缩官方自己会写一条
//   {"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":N}}
// 阈值设成 30 万(thr=287000)之后,压在硬上限附近的那几次 trigger:"auto"(preTokens 口径):
//   264276(92.1%) 267847(93.3%) 271643(94.6%) 278053(96.9%)
//   (原来这串末尾还列着 287745(100.3%),但那条只在子代理转录里 —— 客户端只扫会话目录第一层,
//    205 份顶层转录里一条都没有。删掉之后推导不变:最早那次 264276 = 92.08% 确实在顶层转录里。)
// 根因:官方判定用的是**按字节估的** token($f(e,n.bytesPerToken)),
// 而 preTokens 是 API 回报的口径,两者差约 8%。
// 所以红线不能用官方的 thr-20000(=93.3%)—— 最早那次 92.1% 就压了,那时候还是黄档。
// 取 0.90 作为经验红线:低于实测最早那次(92.1%)约 2%(≈ 一轮的量),又不至于天天喊狼来了。
// ⚠️ 注意这里的百分比用的是 preTokens;药丸读数比 preTokens 还低(中位 0.36%、最大一次 20.9%),
// 所以「90% 保证压缩时已经红了」**不成立** —— 真正的兜底是下面的实测校准。
const COMPACT_RED_RATIO = 0.90;
// ⚠️⚠️ 上面这套算法只是**估算**,而且实测会错得很厉害 —— 不是推断,是数出来的。
// 2026-11-10 把全部 205 个转录扫了一遍,77 次 trigger:"auto"。
// 单看 11-10 那天的 18 次自动压缩,真实压缩点(药丸口径)从 **213267 一直散到 608177**(中位 26.8 万)。
// 那天配置被改过两次(100万 → 30万 → 100万),但**最要紧的证据是改回 100 万之后**:
// 13:56 / 14:24 / 14:42 / 16:00 四次压缩仍然发生在 264390 / 263271 / 264954 / 264374,
// 也就是说已经在跑的会话压根不认新配置,而且真实上限只有估算值(98.7 万)的四分之一出头。
// 反过来也有:06:31 那次压在 608177,远高于当时算出来的任何阈值。
// 其中 3 次压缩发生时药丸还是绿的(255743 / 251644 / 213267,都低于 258300 红线)。
// 根因有两条,客户端都读不到:
//   1) 官方真实窗口 = min(模型自己的 contextWindow, 你配的值)(claude.exe 的 Kb())。
//      而模型窗口来自**服务端下发**的模型目录(Yh→jr(),带 servedWindow/recognized 字段),
//      既不在二进制里硬编码,本机 autoCompactWindowsCache 也是 null —— 查过,拿不到。
//   2) 窗口还叠四层 settings + 服务端下发值。
// → 所以不猜:**用这个会话自己压过的实测点来校准**。
//   官方每次压缩都往转录里写 compact_boundary,parseNew 已经把「压缩前一轮的药丸读数」
//   记进账本的 entry.ac。有这个数就拿它当分母,比任何算出来的阈值都准。
const CALIB_MARGIN = 0.95;   // 判断值(非实测):在"它上次真的压了"那个点再往前留 5% 余量
// 实测点会过期:他 11-09 把窗口配成 30 万、11-10 又改回 100 万,
// 那几个在 26 万压过的会话如果一直按 26 万报红,就是纯噪音(真实上限已经变成 98.7 万了)。
// 作废判据不用猜:**如果当前读数已经明显超过那个实测点却没压,说明那个点已经不是上限了。**
// ⚠️ 但这条只管「实测点偏小」一个方向。反方向(窗口被**改小**,实测点比新上限大得多)
// 它永远不会触发 —— 读数在官方压缩前根本到不了那个过大的实测点,结果就是**该红的时候不红**。
// 所以另加一条上界夹:实测点明显高过算出来的硬上限时也作废。
// thr 本身不准,但量级是对的,拿它当上界比完全不夹强;而且方向是偏报警的
// (误作废只会让红线提前,误采信会让红线永远不来)。
const CALIB_STALE = 1.15;
const ctxCache = {};               // sessSlug|sid|remindAt -> { t, v },挡住定时刷新的重复磁盘读

// 这个会话实测的自动压缩点(药丸口径),0 = 还没测到。
// 只读账本缓存,不触发解析 —— liveContext 每 15 秒跑一次,不能在这里扛解析开销;
// 账本自己的 sessionUsage/warmup 会把它喂新。
function autoCompactPoint(dir, sid) {
  if (!sid) return 0;
  try {
    const e = load()[sid];
    if (!e || e.slug !== path.basename(dir)) return 0;
    const v = e.ac;
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;
  } catch { return 0; }
}

function scanCtxTail(fp, st, len) {
  let txt;
  try {
    // ⚠️ 同 sessionTimeline:closeSync 必须在 finally 里,否则 readSync 一抛就泄漏句柄。
    // 这个函数挂在 15 秒一跳的 refreshCtx 上,而且一次调用里窗口放大最多会开 4 次句柄
    // —— 转录被间歇占用(杀毒/备份/网络盘)时攒到 EMFILE,顶栏就彻底读不出数了。
    // readSync 的返回值同样要用上,别把没写满的零字节解析进去(第七轮验收 P2-3 / P3-6)。
    let fd = null, n = 0;
    const buf = Buffer.alloc(len);
    try {
      fd = fs.openSync(fp, 'r');
      n = fs.readSync(fd, buf, 0, len, st.size - len);
    } finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
    txt = buf.toString('utf8', 0, n);
    // 读不出来(文件被换掉/占用)就直接认输,sawLine 必须报 true,
    // 否则下面会以为"没看到完整行",一路放大窗口去重试一个读不了的文件。
  } catch { return { hit: null, sawLine: true }; }
  const lines = txt.split('\n');
  // 从后往前找第一条带 usage 的 assistant。尾部切口会把头一行切坏,
  // JSON.parse 失败就跳过,不用额外判断。
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln || ln.indexOf('"usage"') < 0 || ln.indexOf('"assistant"') < 0) continue;
    let e; try { e = JSON.parse(ln); } catch { continue; }
    if (!e || e.type !== 'assistant' || !e.message) continue;
    const u = e.message.usage;
    if (!u) continue;
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (!ctx) continue;
    return {
      hit: {
        ctx,
        model: String(e.message.model || '').replace(/^claude-/, ''),
        at: e.timestamp ? Date.parse(e.timestamp) : 0,
        mtime: st.mtimeMs
      },
      sawLine: true
    };
  }
  // 这段尾部里有没有哪怕一条「完整的行」?
  // 窗口的第一行一定被切口切坏了不算,末尾那个空串是行尾换行留下的也不算。
  // 一条都没有 → 不是「没有 usage」,是最后一行本身就比窗口还长(贴了大段日志/大图那一轮),
  // 得放大窗口重来。有完整行却没找到 usage → 就是真没有,别白读。
  let complete = lines.length - 1;
  if (lines[lines.length - 1] === '') complete--;
  // ⚠️ 光看"有没有完整行"不够:超长那一行后面几乎总跟着 tool_result,
  // 于是 complete>0 成立、直接认输 —— 这个兜底在最常见的情形下等于没做(实测复现)。
  // 再看一眼窗口第一行(必然被切口切坏的那条):它自己就很大,说明被切断的是一条巨行,
  // 真正要找的 usage 可能还在它里面,得放大窗口。
  const headHuge = lines[0] && lines[0].length > 64 * 1024;
  return { hit: null, sawLine: complete > 0 && !headHuge };
}

function sessionContext(dir, sid) {
  const fp = path.join(dir, sid + '.jsonl');
  let st; try { st = fs.statSync(fp); } catch { return null; }
  if (st.size <= 0) return null;
  let len = Math.min(st.size, CTX_TAIL);
  for (;;) {
    const r = scanCtxTail(fp, st, len);
    if (r.hit) return Object.assign({ sid }, r.hit);
    if (r.sawLine || len >= st.size || len >= CTX_TAIL_MAX) return null;
    len = Math.min(st.size, len * 8, CTX_TAIL_MAX);
  }
}

// 压缩窗口:settings.json 顶层 autoCompactWindow,可被 modelSettings.<model> 覆盖。
// 官方允许的范围 100000~1000000,也允许写成 "auto"(交给服务端定)——
// "auto" 这种非数字值我们算不出来,按默认 100 万处理,真实窗口不符时靠 >100% 的「阈值待定」兜。
// 注意:这里只读用户级 settings.json 这一层。官方实际还会叠 managed/项目/local 四层,
// 外加服务端下发的 auto_compact_windows(缓存在 ~/.claude.json 的 autoCompactWindowsCache),
// 所以这个数不是绝对权威,只是最常见那一层。
const CTX_WIN_MIN = 100000, CTX_WIN_MAX = 1000000;
function normModel(x) { return String(x || '').toLowerCase().replace(/^claude-/, ''); }
function winOf(o) {
  const v = o && o.autoCompactWindow;
  if (typeof v !== 'number' || !isFinite(v)) return null;      // "auto" / null / 漏写都走这里
  // 越界值**夹到边界**,不是当没配。官方对环境变量那层就是夹的(原文:"treats it as
  // the 100k minimum" / "1M maximum")。当没配的话 50000 会退到默认 100 万,差 20 倍,
  // 往大了差比往小了差危险得多 —— 顶栏会说"还早呢",其实早该收尾了。
  return Math.min(CTX_WIN_MAX, Math.max(CTX_WIN_MIN, Math.round(v)));
}
function compactWindow(model) {
  try {
    const s = JSON.parse(fs.readFileSync(require('./paths').CLAUDE_SETTINGS, 'utf8'));
    const ms = s.modelSettings;
    if (ms && model) {
      const m = normModel(model);
      const keys = Object.keys(ms).filter(k => k).sort((a, b) => b.length - a.length);
      // 1) 精确命中
      for (const k of keys) if (normModel(k) === m) { const w = winOf(ms[k]); if (w) return w; }
      // 2) 只允许**不含数字的族别名**(opus / sonnet / haiku / fable)前缀命中。
      //    绝不能让带版本号的键去前缀匹配:`opus-5` 和 `opus-5-5` 是两个不同的模型,
      //    官方归一化后并不相等,把 opus-5 的窗口套到 opus-5-5 上是实测复现过的错配。
      //    带版本号的键匹配不上就退到顶层值 —— 宁可报全局阈值,也不报一个错的。
      for (const k of keys) {
        const kl = normModel(k);
        if (kl && !/\d/.test(kl) && m.startsWith(kl + '-')) { const w = winOf(ms[k]); if (w) return w; }
      }
    }
    return winOf(s) || CTX_WIN_DEFAULT;
  } catch { return CTX_WIN_DEFAULT; }
}

// 某项目目录里「正在动」的那个会话的上下文占用。
// 不给 sid 就取该目录下 mtime 最新的 .jsonl(正在跑的那个)。
const CTX_FALLBACK_FRESH = 60 * 1000;   // 没 sid 时才用「目录里最新那个」,且必须 60 秒内动过
// 超出分母多少才算「这个分母不可信」。
// 不能一超过 100% 就翻成"阈值待定" —— 实测官方压在超过硬上限之后的,**按药丸口径**:
//   100 万配置下 thr = 987000,而 77 次自动压缩里有 **39 次的药丸读数超过 987000**,
//   最高 999950 = 101.31%(999934 / 999867 紧随其后)。
//   ⚠️ 别再拿 preTokens 的百分比来论证这件事(287745 / 1001173 / 1011598 都是 preTokens 口径,
//   其中 287745 还只出现在子代理转录里 —— 客户端只扫会话目录第一层,根本不读它)。
// 而那正是最危险的时刻,从红翻灰等于在压缩前一秒把警报关掉。
// 真正说明分母算错的是大幅超出(11-10 那天有会话跑在 thr 的 135% / 169% / 212%)。
const CTX_UNKNOWN_PCT = 115;

// 药丸该显示成什么档。放在这里而不是渲染层,是为了能被测试和变异验证盯住。
//   hot  = 官方马上要自动压缩(红)
//   warn = 到了用户自己定的收尾线,该主动开新会话(橙)
//   unk  = 阈值明显算错了、而且也没过收尾线,只报数不报警(灰)
//   ok   = 正常
//
// ⚠️ 顺序是有讲究的(2026-11-10 被验收抓到):第一版把 unk 判在 warn 前面,
// 结果「阈值算不准」会把**用户自己定的那条线一起关掉** —— 而收尾线是个绝对 token 数,
// 恰恰是在算不准官方阈值的时候**唯一还可信的那条线**。
// 实测踩到过:他 11-10 有个会话整段跑在 thr 的 192%,收尾线全程是死的。
// 现在 unk 只挡住「官方压缩线」这一档,管不着收尾线。
// 字段坏了就当「阈值不可信」,而不是当「正常」—— 缺省方向必须是报警,不是静默。
// 只在这一处算,ctxLevel 和 thrUnknown 都从它取,免得同一个判据两处各写一份。
function ctxNums(r) {
  const redAt = (typeof r.redAt === 'number' && isFinite(r.redAt) && r.redAt > 0) ? r.redAt : 0;
  const pct = (typeof r.pct === 'number' && isFinite(r.pct)) ? r.pct : Infinity;
  return { redAt: redAt, pct: pct, unk: !redAt || pct > CTX_UNKNOWN_PCT };
}
// 分母能不能信(画虚线框、文字写"阈值待定"用)。和档位是两件事:
// 阈值算不准、但已经过了收尾线时,要同时虚线框 + 橙色。
function ctxUnknown(r) { return !r || !r.ctx ? false : ctxNums(r).unk; }
function ctxLevel(r, remindAt) {
  if (!r || !r.ctx) return 'ok';
  const n = ctxNums(r);
  if (!n.unk && r.ctx >= n.redAt) return 'hot';
  if (remindAt > 0 && r.ctx >= remindAt) return 'warn';
  return n.unk ? 'unk' : 'ok';
}

// dir 是否真在 root 底下。先按字面比,再用 realpath 比一次 ——
// 字面比较挡不住 junction / symlink(Windows 上 mklink /J 建的目录链接),
// 字面上看着在界内,真身可能指到任何地方。
function inside(root, dir) {
  const lit = path.relative(root, dir);
  if (lit === '' || lit.startsWith('..') || path.isAbsolute(lit)) return false;
  try {
    const rr = fs.realpathSync(root);
    const rd = fs.realpathSync(dir);       // 目录不存在会抛,下面当"界内但读不到"处理
    const r2 = path.relative(rr, rd);
    if (r2 === '' || r2.startsWith('..') || path.isAbsolute(r2)) return false;
  } catch { /* 目录不存在:字面已经过了,后面 readdir/stat 自然失败 */ }
  return true;
}
function liveContext(sessSlug, sid, remindAt) {
  const slug = String(sessSlug || '');
  if (!slug) return null;
  const rem = (typeof remindAt === 'number' && remindAt > 0) ? Math.round(remindAt) : 0;
  // 缓存 key 必须带上 remindAt,否则在设置里改完收尾线,2 秒内还是旧档
  const key = slug + '|' + (sid || '') + '|' + rem;
  const hit = ctxCache[key];
  if (hit && Date.now() - hit.t < 2000) return hit.v;
  const root = require('./paths').CLAUDE_PROJECTS;
  const dir = path.resolve(root, slug);
  // slug 来自渲染进程,必须确认没越出 ~/.claude/projects —— 之前只校验了 sid,
  // 测试里那几条穿越用例「通过」只是因为目标目录里恰好没有 .jsonl,是假的安全感。
  if (!inside(root, dir)) { ctxCache[key] = { t: Date.now(), v: null }; return null; }
  let r = null;
  if (sid) {
    // sid 不合法就直接认输,不能退回「目录里最新那个」—— 那会把别的会话的数字贴到这个标签上
    if (/^[\w-]+$/.test(sid)) r = sessionContext(dir, sid);
  } else {
    let files = []; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { files = []; }
    let best = null;
    for (const f of files) {
      let st; try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
      if (!best || st.mtimeMs > best.m) best = { f: f, m: st.mtimeMs };
    }
    if (best && Date.now() - best.m <= CTX_FALLBACK_FRESH) r = sessionContext(dir, best.f.replace(/\.jsonl$/, ''));
  }
  let out = null;
  if (r) {
    const win = compactWindow(r.model);
    const thr = Math.max(1, win - COMPACT_RESERVE);   // 官方硬上限(算出来的)
    // ⚠️ 先把账本喂新再取实测点。不喂的话 ac 只有「切项目」和启动预热会更新 ——
    // 他的用法是开着客户端在一个项目里连着干一整天,期间会话压了好几次却没人去读转录,
    // 实测点一直冻在启动那一刻的值(第三轮验收实测复现)。
    // light=true 自带 8MB 上限(超限转为延后一拍兜底),外面还有 2 秒缓存 + 15 秒 tick。
    // ⚠️ 但只能在「这个条目本来就属于这个目录」时喂:sessionUsage 第一件事就是把
    // entry.slug 改写成当前目录的 basename,而 autoCompactPoint 正是靠
    // 「entry.slug === basename(dir)」挡住「同一个 sid 出现在两个目录下」的串线 ——
    // 先喂再读等于把那道校验废掉(第四轮验收 P2-2)。
    if (r.sid) {                 // 兜底分支(没给 sid、取目录里最新那个)同样要喂,否则它永远用不上实测点
      try {
        const e0 = load()[r.sid];
        if (!e0 || e0.slug === path.basename(dir)) sessionUsage(dir, r.sid, true);
      } catch {}
    }
    let calib = autoCompactPoint(dir, r.sid);         // 这个会话实测压过的点,0 = 没测到
    if (calib > 0 && r.ctx > calib * CALIB_STALE) calib = 0;   // 读数都过去了还没压 → 这个点过期了
    if (calib > thr * CALIB_STALE) calib = 0;                  // 实测点比硬上限还高一截 → 窗口被改小了
    // 分母和红线:有实测点就用实测点(它才是这个会话的真实天花板),没有才用算的。
    // 红线取「官方 warn 档」和「经验 90%」里**更早**的那个。
    // 30 万:min(267000, 258300) = 258300;100 万:min(967000, 888300) = 888300。
    const eff = calib > 0 ? calib : thr;
    const redAt = calib > 0
      ? Math.max(1, Math.round(calib * CALIB_MARGIN))
      : Math.max(1, Math.min(thr - 20000, Math.round(thr * COMPACT_RED_RATIO)));
    out = Object.assign(r, {
      win: win, thr: thr, eff: eff, calib: calib,
      redAt: redAt,
      pct: Math.round(r.ctx / eff * 100),
      fallback: !sid,
      remindAt: rem
    });
    out.level = ctxLevel(out, rem);
    out.thrUnknown = ctxUnknown(out);
  }
  ctxCache[key] = { t: Date.now(), v: out };
  return out;
}

module.exports = { sessionUsage, saveNow, warmup, aggregates, totalsBySlug, sessionTimeline, dailySeries, exportRows, sessionContext, compactWindow, liveContext, ctxLevel, ctxUnknown, autoCompactPoint, backfillCompactPoints, uniqDirs };
