"use strict";

const STORAGE_KEY = "star-hero-v1";
const BONUS = 5; // extra stars for finishing every task in a day
const AVATARS = ["🦁", "🐼", "🐰", "🦊", "🐯", "🐨", "🐸", "🦄", "🐧", "🐶", "🐱", "🦖"];
const LEVELS = [
  [0, "星星新手"],
  [20, "小小努力家"],
  [50, "任务达人"],
  [100, "自律小明星"],
  [200, "闪耀勇士"],
  [400, "超级英雄"],
  [700, "星空大师"],
  [1000, "传奇之星"],
];

const DEFAULT_STATE = {
  name: "小勇士",
  avatar: "🦁",
  balance: 0,
  totalEarned: 0,
  redeemed: 0,
  tasks: [
    { id: "t1", icon: "🪥", name: "早上刷牙", points: 1 },
    { id: "t8", icon: "🪥", name: "午饭刷牙", points: 1 },
    { id: "t9", icon: "🪥", name: "晚上刷牙", points: 1 },
    { id: "t2", icon: "👕", name: "自己穿衣服", points: 2 },
    { id: "t3", icon: "📚", name: "阅读20分钟", points: 3 },
    { id: "t4", icon: "✏️", name: "完成作业", points: 3 },
    { id: "t5", icon: "🧸", name: "收拾玩具", points: 2 },
    { id: "t6", icon: "🥦", name: "好好吃饭不挑食", points: 2 },
    { id: "t7", icon: "🌙", name: "按时睡觉", points: 2 },
  ],
  rewards: [
    { id: "r1", icon: "🍦", name: "一个冰淇淋", cost: 15 },
    { id: "r2", icon: "📺", name: "看动画片30分钟", cost: 20 },
    { id: "r3", icon: "🎮", name: "玩游戏30分钟", cost: 25 },
    { id: "r4", icon: "🛝", name: "去公园玩", cost: 40 },
    { id: "r5", icon: "📖", name: "买一本新书", cost: 60 },
    { id: "r6", icon: "🧸", name: "挑一个小玩具", cost: 100 },
  ],
  // Task records are the source of truth for completions, streaks and the "today" checkmarks.
  records: [], // { id, taskId, name, icon, points, t, by: { username, role } }, newest first
  bonusDays: [],
  history: [], // other star changes: { t, icon, text, amount, by?, type?, date? }
};

const BADGES = [
  { icon: "👣", name: "第一步", desc: "完成第1个任务", test: (s) => s.totalEarned > 0 },
  { icon: "💯", name: "全勤一天", desc: "一天完成全部", test: (s) => s.bonusDays.length > 0 },
  { icon: "🔥", name: "坚持3天", desc: "连续3天打卡", test: (s) => bestStreak(s) >= 3 },
  { icon: "🌈", name: "坚持7天", desc: "连续7天打卡", test: (s) => bestStreak(s) >= 7 },
  { icon: "⭐", name: "50颗星", desc: "累计50颗星", test: (s) => s.totalEarned >= 50 },
  { icon: "🌟", name: "200颗星", desc: "累计200颗星", test: (s) => s.totalEarned >= 200 },
  { icon: "🎁", name: "第一份礼物", desc: "第1次兑换", test: (s) => s.redeemed >= 1 },
  { icon: "👑", name: "兑换达人", desc: "兑换10次", test: (s) => s.redeemed >= 10 },
];

let state = structuredClone(DEFAULT_STATE);
let me = null; // { username, role, family: { name } } of the logged-in family member
let members = [];
let parentUnlocked = false;
let lockAnswer = 0;

const $ = (sel) => document.querySelector(sel);

/* ---------------- storage (server) & dates ---------------- */

function withDefaults(saved) {
  const s = { ...structuredClone(DEFAULT_STATE), ...saved };
  if (s.days) {
    // Older data kept only task ids per day; turn those into records (submitter unknown).
    for (const [date, ids] of Object.entries(s.days)) {
      const [y, m, d] = date.split("-").map(Number);
      for (const taskId of ids) {
        const task = s.tasks.find((t) => t.id === taskId) || { name: "已删除的任务", icon: "❔", points: 0 };
        s.records.push({ id: newId("rec"), taskId, name: task.name, icon: task.icon, points: task.points, t: new Date(y, m - 1, d, 12).getTime(), by: null });
      }
    }
    s.records.sort((a, b) => b.t - a.t);
    delete s.days;
  }
  return s;
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// fetch for data endpoints: a 401 means the session ended, so go back to the login screen.
async function api(url, options = {}) {
  const res = await fetch(url, { cache: "no-store", ...options });
  if (res.status === 401) {
    showAuth("登录已过期，请重新登录");
    throw new Error("请先登录");
  }
  return res;
}

async function load() {
  const res = await api("/api/state");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.status === 204) {
    // Nothing on the server yet: carry over data from the earlier browser-only version once.
    const local = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (local) {
      state = withDefaults(local);
      await putState();
      localStorage.removeItem(STORAGE_KEY);
    }
    return;
  }
  state = withDefaults(await res.json());
}

// Saves are debounced and sent one at a time, so the server always ends with the latest state.
let saveTimer = null;
let saveChain = Promise.resolve();
let savesInFlight = 0;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  savesInFlight++;
  saveChain = saveChain
    .then(putState)
    .catch(() => toast("⚠️ 保存到服务器失败，请检查网络"))
    .finally(() => savesInFlight--);
  return saveChain;
}

async function putState() {
  const res = await api("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  if (res.status === 409) {
    // Another family member saved first: take their version rather than overwrite it.
    state = withDefaults(await res.json());
    render();
    toast("家人刚刚更新了数据，已同步，请再操作一次");
    return;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  state.rev = (await res.json()).rev;
}

// Pick up changes other family members made, unless this device has unsaved changes of its own.
async function refresh() {
  if (!me || saveTimer || savesInFlight || document.hidden) return;
  try {
    const res = await api("/api/state");
    if (res.status !== 200 || saveTimer || savesInFlight) return;
    const latest = await res.json();
    if (latest.rev === state.rev) return;
    state = withDefaults(latest);
    render();
  } catch {}
}
document.addEventListener("visibilitychange", refresh);

addEventListener("pagehide", () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    navigator.sendBeacon("/api/state", new Blob([JSON.stringify(state)], { type: "application/json" }));
  }
});

function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shiftDay(key, delta) {
  const [y, m, d] = key.split("-").map(Number);
  return dateKey(new Date(y, m - 1, d + delta));
}

const recordDate = (rec) => dateKey(new Date(rec.t));

function doneOn(date) {
  return state.records.filter((r) => recordDate(r) === date).map((r) => r.taskId);
}

function doneToday() {
  return doneOn(dateKey());
}

function activeDays(s) {
  return new Set(s.records.map(recordDate));
}

function currentStreak(s) {
  const days = activeDays(s);
  let key = dateKey();
  if (!days.has(key)) key = shiftDay(key, -1); // today not started yet: keep yesterday's streak alive
  let n = 0;
  while (days.has(key)) {
    n++;
    key = shiftDay(key, -1);
  }
  return n;
}

function bestStreak(s) {
  const days = activeDays(s);
  let best = 0;
  for (const key of days) {
    if (days.has(shiftDay(key, -1))) continue; // only count from the start of a run
    let n = 0;
    let k = key;
    while (days.has(k)) {
      n++;
      k = shiftDay(k, 1);
    }
    best = Math.max(best, n);
  }
  return best;
}

function levelInfo(total) {
  let i = 0;
  while (i + 1 < LEVELS.length && total >= LEVELS[i + 1][0]) i++;
  const [start, name] = LEVELS[i];
  const next = LEVELS[i + 1];
  const pct = next ? ((total - start) / (next[0] - start)) * 100 : 100;
  return { label: `Lv.${i + 1} ${name}`, pct, toNext: next ? next[0] - total : 0 };
}

/* ---------------- state changes ---------------- */

function addStars(amount, icon, text, extra = {}) {
  state.balance += amount;
  if (amount > 0) state.totalEarned += amount;
  state.history.unshift({ t: Date.now(), icon, text, amount, by: byMe(), ...extra });
  state.history = state.history.slice(0, 200);
}

const byMe = () => (me ? { username: me.username, role: me.role } : null);

// Changing a record's stars also changes the balance and the lifetime total.
function changeEarned(delta) {
  state.balance += delta;
  state.totalEarned += delta;
}

// If a day lost a task record after its full-attendance bonus was granted, take the bonus back.
function revokeBonusIfIncomplete(date) {
  if (!state.bonusDays.includes(date)) return;
  const done = doneOn(date);
  if (state.tasks.every((t) => done.includes(t.id))) return;
  state.bonusDays = state.bonusDays.filter((d) => d !== date);
  changeEarned(-BONUS);
  const i = state.history.findIndex((h) => h.type === "bonus" && h.date === date);
  if (i >= 0) state.history.splice(i, 1);
}

function deleteRecord(rec) {
  rec = state.records.find((r) => r.id === rec.id); // the state may have been refreshed since rec was read
  if (!rec) return;
  state.records = state.records.filter((r) => r.id !== rec.id);
  changeEarned(-rec.points);
  revokeBonusIfIncomplete(recordDate(rec));
}

function updateRecord(rec, { t, points }) {
  const oldDate = recordDate(rec);
  changeEarned(points - rec.points);
  Object.assign(rec, { t, points });
  state.records.sort((a, b) => b.t - a.t);
  if (recordDate(rec) !== oldDate) revokeBonusIfIncomplete(oldDate);
}

// Undo the most recent completion of this task today (records are newest first).
function undoTask(task) {
  const today = dateKey();
  const latest = state.records.find((r) => r.taskId === task.id && recordDate(r) === today);
  if (!latest) return;
  confirmModal("🤔", `撤销一次「${task.name}」？`, `这次的 ${latest.points} 颗星会被收回，这条任务记录也会删除`, "撤销", () => {
    deleteRecord(latest);
    save();
    render();
  });
}

// A task can be completed any number of times; each completion is its own record.
function completeTask(task) {
  const today = dateKey();
  const badgesBefore = earnedBadges();
  state.records.unshift({ id: newId("rec"), taskId: task.id, name: task.name, icon: task.icon, points: task.points, t: Date.now(), by: byMe() });
  changeEarned(task.points);
  celebrate(task);

  const done = doneOn(today);
  const allDone = state.tasks.length > 0 && state.tasks.every((t) => done.includes(t.id));
  if (allDone && !state.bonusDays.includes(today)) {
    state.bonusDays.push(today);
    addStars(BONUS, "💯", "全勤奖励", { type: "bonus", date: today });
    // After the task's own animation: a full fireworks show, then the congratulations dialog.
    setTimeout(() => {
      fireworks(6, { spread: 400 });
      confetti();
      playSound("win");
    }, 2500);
    setTimeout(() => infoModal("🎉", "太棒啦！今天全部完成！", `额外奖励 ${BONUS} 颗星星，你是最棒的！`), 4900);
  }

  save();
  render();
  announceNewBadges(badgesBefore, allDone ? 5200 : 2600);
}

function redeem(reward, el) {
  if (state.balance < reward.cost) {
    el.classList.remove("shake");
    void el.offsetWidth;
    el.classList.add("shake");
    playSound("nope");
    toast(`还差 ${reward.cost - state.balance} 颗星星，继续加油！💪`);
    return;
  }
  confirmModal(reward.icon, `兑换「${reward.name}」？`, `需要花费 ${reward.cost} 颗星星`, "确定兑换", () => {
    const badgesBefore = earnedBadges();
    state.redeemed += 1;
    addStars(-reward.cost, reward.icon, `兑换：${reward.name}`);
    save();
    render();
    confetti();
    playSound("win");
    infoModal(reward.icon, "兑换成功！", `快去找爸爸妈妈领取「${reward.name}」吧！`);
    announceNewBadges(badgesBefore, 2500);
  });
}

function earnedBadges() {
  return BADGES.filter((b) => b.test(state)).map((b) => b.name);
}

function announceNewBadges(before, delay) {
  const fresh = BADGES.filter((b) => b.test(state) && !before.includes(b.name));
  if (!fresh.length) return;
  setTimeout(() => {
    const b = fresh[0];
    confetti();
    infoModal(b.icon, `获得新徽章：${b.name}`, b.desc);
  }, delay);
}

/* ---------------- rendering ---------------- */

function render() {
  const done = doneToday();
  const lv = levelInfo(state.totalEarned);

  $("#kidName").textContent = state.name;
  $("#avatarBtn").textContent = state.avatar;
  $("#levelName").textContent = lv.label;
  $("#levelFill").style.width = `${lv.pct}%`;
  setBalance(state.balance);
  $("#streak").textContent = currentStreak(state);
  $("#totalEarned").textContent = state.totalEarned;

  const doneCount = state.tasks.filter((t) => done.includes(t.id)).length;
  $("#todayDone").textContent = `${doneCount}/${state.tasks.length}`;
  $("#today").textContent = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  const pct = state.tasks.length ? (doneCount / state.tasks.length) * 100 : 0;
  $("#progressFill").style.width = `${pct}%`;
  const left = state.tasks.length - doneCount;
  $("#progressTip").textContent = !state.tasks.length
    ? ""
    : left === 0
      ? "🎉 今天的任务全部完成啦！"
      : `再完成 ${left} 个任务，就能拿到全勤奖励 +${BONUS}⭐`;

  renderTasks(done);
  renderRewards();
  renderBadges();
  renderHistory();
  if (parentUnlocked) renderParent();
}

let shownBalance = null;
function setBalance(n) {
  const el = $("#balance");
  if (shownBalance !== null && n !== shownBalance) {
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
  }
  shownBalance = n;
  el.textContent = n;
}

function renderTasks(done) {
  const count = (id) => done.filter((d) => d === id).length;
  const ul = $("#taskList");
  ul.innerHTML = "";
  if (!state.tasks.length) {
    ul.innerHTML = `<li class="empty">还没有任务哦，请爸爸妈妈在「家长」里添加～</li>`;
    return;
  }
  for (const task of state.tasks) {
    const n = count(task.id);
    const li = document.createElement("li");
    li.className = "task-item";
    const btn = document.createElement("button");
    btn.className = "task" + (n ? " done" : "");
    btn.innerHTML = `
      <span class="task-icon"></span>
      <span class="task-name"></span>
      <span class="task-pts">+${task.points} ⭐</span>
      <span class="task-check">${n > 1 ? `×${n}` : "✓"}</span>`;
    setVisual(btn.querySelector(".task-icon"), task);
    btn.querySelector(".task-name").textContent = task.name;
    btn.addEventListener("click", () => completeTask(task));
    li.append(btn);
    if (n) {
      const undo = document.createElement("button");
      undo.className = "task-undo";
      undo.textContent = "撤销";
      undo.title = "撤销最近一次";
      undo.addEventListener("click", () => undoTask(task));
      li.append(undo);
    }
    ul.append(li);
  }
}

// Rewards sit on wooden shelves, three per shelf, each with a hanging price tag.
const PER_SHELF = 3;
function renderRewards() {
  $("#shopBalance").textContent = state.balance;
  const cabinet = $("#rewardList");
  cabinet.innerHTML = "";
  if (!state.rewards.length) {
    cabinet.innerHTML = `<p class="empty shelf-empty">货架还空着，请爸爸妈妈在「家长」里添加奖品～</p>`;
    return;
  }
  for (let i = 0; i < state.rewards.length; i += PER_SHELF) {
    const shelf = document.createElement("div");
    shelf.className = "shelf";
    for (const r of state.rewards.slice(i, i + PER_SHELF)) {
      const can = state.balance >= r.cost;
      const goods = document.createElement("button");
      goods.className = "goods" + (can ? " can" : "");
      goods.innerHTML = `
        <span class="goods-icon"></span>
        <span class="price-tag">
          <span class="tag-name"></span>
          <span class="tag-price">${r.cost}<small>⭐</small></span>
          <span class="tag-note">${can ? "可兑换" : `还差 ${r.cost - Math.max(0, state.balance)}⭐`}</span>
        </span>`;
      setVisual(goods.querySelector(".goods-icon"), r);
      goods.querySelector(".tag-name").textContent = r.name;
      goods.addEventListener("click", () => redeem(r, goods));
      shelf.append(goods);
    }
    cabinet.append(shelf);
  }
}

function renderBadges() {
  $("#badgeList").innerHTML = BADGES.map(
    (b) => `<li class="badge ${b.test(state) ? "" : "off"}"><span>${b.icon}</span>${b.name}<small>${b.desc}</small></li>`,
  ).join("");
}

// Shows a task's uploaded image, or its emoji when it has none.
function setVisual(el, item) {
  el.textContent = "";
  if (item.image) {
    const img = document.createElement("img");
    img.src = item.image;
    img.alt = "";
    el.append(img);
  } else {
    el.textContent = item.icon || "⭐";
  }
}

// Records keep the task's name/emoji from when they were submitted; images come from the current task.
const recordVisual = (rec) => ({ icon: rec.icon, image: state.tasks.find((t) => t.id === rec.taskId)?.image });
const byText = (by) => (by ? `${by.role} ${by.username}` : "");
const timeText = (t, opts) => new Date(t).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", ...opts });

function renderHistory() {
  const ul = $("#historyList");
  ul.innerHTML = "";
  const entries = [
    ...state.records.map((r) => ({ ...recordVisual(r), t: r.t, text: r.name, amount: r.points, by: r.by })),
    ...state.history,
  ].sort((a, b) => b.t - a.t);
  if (!entries.length) {
    ul.innerHTML = `<li class="empty">完成任务后，星星记录会出现在这里</li>`;
    return;
  }
  for (const h of entries.slice(0, 50)) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="h-icon"></span>
      <span class="h-text"><span></span><small></small></span>
      <span class="h-amt ${h.amount >= 0 ? "plus" : "minus"}">${h.amount >= 0 ? "+" : ""}${h.amount}⭐</span>`;
    setVisual(li.querySelector(".h-icon"), h);
    li.querySelector(".h-text span").textContent = h.text;
    li.querySelector(".h-text small").textContent = [timeText(h.t, { month: "numeric", day: "numeric" }), byText(h.by)].filter(Boolean).join(" · ");
    ul.append(li);
  }
}

/* ---------------- parent area ---------------- */

function newLockQuestion() {
  const a = 11 + Math.floor(Math.random() * 15);
  const b = 3 + Math.floor(Math.random() * 7);
  lockAnswer = a * b;
  $("#lockQuestion").textContent = `${a} × ${b} = ?`;
  $("#lockAnswer").value = "";
}

function renderParent() {
  $("#parentLock").classList.toggle("hidden", parentUnlocked);
  $("#parentArea").classList.toggle("hidden", !parentUnlocked);
  if (!parentUnlocked) return;

  $("#accountName").textContent = `${me.username}（${me.role}）`;
  const nameInput = $("#nameInput");
  if (document.activeElement !== nameInput) nameInput.value = state.name;

  $("#avatarPick").innerHTML = "";
  for (const a of AVATARS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a;
    b.className = a === state.avatar ? "sel" : "";
    b.addEventListener("click", () => {
      state.avatar = a;
      save();
      render();
    });
    $("#avatarPick").append(b);
  }

  renderEditList($("#editTasks"), state.tasks, "points", "颗星", (t) => openItemEditor("task", t));
  renderEditList($("#editRewards"), state.rewards, "cost", "颗星", (r) => openItemEditor("reward", r));
  renderRecords();
}

let recordLimit = 20;
function renderRecords() {
  const ul = $("#recordList");
  ul.innerHTML = "";
  if (!state.records.length) ul.innerHTML = `<li class="empty">还没有任务记录</li>`;
  let lastDay = "";
  for (const rec of state.records.slice(0, recordLimit)) {
    const day = recordDate(rec);
    if (day !== lastDay) {
      lastDay = day;
      const h = document.createElement("li");
      h.className = "rec-day";
      h.textContent = new Date(rec.t).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });
      ul.append(h);
    }
    const li = document.createElement("li");
    li.className = "rec";
    li.innerHTML = `
      <span class="e-icon"></span>
      <span class="e-name"><span></span><small></small></span>
      <span class="e-pts">+${rec.points}⭐</span>
      <button class="btn small" data-act="edit">修改</button>
      <button class="btn small danger" data-act="del">删除</button>`;
    setVisual(li.querySelector(".e-icon"), recordVisual(rec));
    li.querySelector(".e-name span").textContent = rec.name;
    li.querySelector(".e-name small").textContent = `${timeText(rec.t)} · ${byText(rec.by) || "提交人未知"}`;
    li.querySelector('[data-act="edit"]').addEventListener("click", () => openRecordEditor(rec));
    li.querySelector('[data-act="del"]').addEventListener("click", () =>
      confirmModal("🗑️", "删除这条任务记录？", `「${rec.name}」的 ${rec.points} 颗星会被收回`, "删除", () => {
        deleteRecord(rec);
        save();
        render();
        toast("记录已删除，星星已退回");
      }),
    );
    ul.append(li);
  }
  $("#moreRecords").classList.toggle("hidden", state.records.length <= recordLimit);
}

function renderEditList(ul, items, numKey, unit, onEdit) {
  ul.innerHTML = "";
  items.forEach((item, i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="e-icon"></span>
      <span class="e-name"></span>
      <span class="e-pts">${item[numKey]} ${unit}</span>
      <button class="btn small" data-act="up" title="上移">↑</button>
      ${onEdit ? `<button class="btn small" data-act="edit">编辑</button>` : ""}
      <button class="btn small danger" data-act="del">删除</button>`;
    setVisual(li.querySelector(".e-icon"), item);
    if (onEdit) li.querySelector('[data-act="edit"]').addEventListener("click", () => onEdit(item));
    li.querySelector(".e-name").textContent = item.name;
    li.querySelector('[data-act="up"]').disabled = i === 0;
    li.querySelector('[data-act="up"]').addEventListener("click", () => {
      [items[i - 1], items[i]] = [items[i], items[i - 1]];
      save();
      render();
    });
    li.querySelector('[data-act="del"]').addEventListener("click", () => {
      confirmModal("🗑️", `删除「${item.name}」？`, "删除后不能恢复", "删除", () => {
        items.splice(i, 1);
        save();
        render();
      });
    });
    ul.append(li);
  });
}

function bindParent() {
  newLockQuestion();
  $("#lockForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (Number($("#lockAnswer").value) === lockAnswer) {
      parentUnlocked = true;
      render();
      loadMembers();
    } else {
      toast("答案不对哦，再试一次");
      $("#parentLock").classList.remove("shake");
      void $("#parentLock").offsetWidth;
      $("#parentLock").classList.add("shake");
      newLockQuestion();
    }
  });

  $("#nameInput").addEventListener("input", (e) => {
    state.name = e.target.value.trim() || "小勇士";
    save();
    $("#kidName").textContent = state.name;
  });

  $("#addTaskBtn").addEventListener("click", () => openItemEditor("task"));
  $("#addRewardBtn").addEventListener("click", () => openItemEditor("reward"));
  $("#moreRecords").addEventListener("click", () => {
    recordLimit += 20;
    renderRecords();
  });
  bindEditors();

  $("#adjustForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    const amount = Math.trunc(Number(f.amount.value));
    if (!amount) return;
    addStars(amount, amount > 0 ? "💝" : "📝", f.reason.value.trim() || `${me.role}${amount > 0 ? "的奖励" : "调整"}`);
    f.reset();
    save();
    render();
    if (amount > 0) playSound("ding");
    toast(`已${amount > 0 ? "奖励" : "扣除"} ${Math.abs(amount)} 颗星`);
  });

  $("#lockBtn").addEventListener("click", () => {
    parentUnlocked = false;
    newLockQuestion();
    renderParent();
  });

  $("#exportBtn").addEventListener("click", async () => {
    await flushSave(); // make sure the download includes the very latest changes
    location.href = "/api/export";
  });

  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    confirmModal("📤", "上传并覆盖数据？", `用「${file.name}」替换服务器上现在的数据`, "上传", async () => {
      try {
        clearTimeout(saveTimer);
        saveTimer = null;
        await saveChain;
        const res = await api("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        state = withDefaults(body);
        render();
        toast("数据已上传 ✅");
      } catch (err) {
        infoModal("😥", "上传失败", err.message || "请检查文件后再试");
      }
    });
  });

  $("#resetBtn").addEventListener("click", () => {
    confirmModal("⚠️", "清空所有数据？", "星星、记录、任务和奖励都会恢复到初始状态", "清空", () => {
      state = { ...structuredClone(DEFAULT_STATE), rev: state.rev }; // keep rev so the save is not seen as a conflict
      save();
      render();
      toast("已恢复初始状态");
    });
  });
}

function clampInt(v, min, max) {
  return Math.min(max, Math.max(min, Math.round(Number(v)) || min));
}

/* ---------------- task / reward & record editors ---------------- */

// Tasks and rewards share one editor; they differ in the list, the number field and defaults.
const EDIT_KINDS = {
  task: { list: () => state.tasks, numKey: "points", max: 99, numLabel: "星星", word: "任务", icon: "🌟", num: 2, prefix: "t" },
  reward: { list: () => state.rewards, numKey: "cost", max: 999, numLabel: "价格", word: "奖品", icon: "🎁", num: 20, prefix: "r" },
};
let editKind = "task";
let editingItemId = null; // null while adding a new item
let editImage = null;
let editingRecordId = null;

function openEditor(sel) {
  $(sel).classList.remove("hidden");
}

function closeEditors() {
  document.querySelectorAll("#itemEditor, #recordEditor, #passwordEditor").forEach((m) => m.classList.add("hidden"));
}

function openItemEditor(kind, item = null) {
  const k = EDIT_KINDS[kind];
  const f = $("#itemEditForm");
  editKind = kind;
  editingItemId = item?.id ?? null;
  editImage = item?.image || null;
  f.icon.value = item?.icon || k.icon;
  f.name.value = item?.name || "";
  f.num.value = item?.[k.numKey] ?? k.num;
  f.num.max = k.max;
  $("#itemNumLabel").textContent = k.numLabel;
  f.querySelector(".task-only").classList.toggle("hidden", kind !== "task");
  f.anim.value = item?.anim || "";
  updateAnimOptions();
  $("#itemEditTitle").textContent = `${item ? "编辑" : "添加"}${k.word}`;
  updateItemPreview();
  openEditor("#itemEditor");
}

// The "auto" option names the animation the current task name would get.
function updateAnimOptions() {
  const f = $("#itemEditForm");
  const chosen = f.anim.value;
  const auto = themeFor({ name: f.name.value.trim() });
  f.anim.innerHTML = [
    ["", `自动（${auto ? THEMES[auto].label : "红包"}）`],
    ...Object.entries(THEMES).map(([k, t]) => [k, t.label]),
    ["envelope", "红包"],
  ].map(([v, label]) => `<option value="${v}">${label}</option>`).join("");
  f.anim.value = chosen;
}

function updateItemPreview() {
  setVisual($("#itemEditPreview"), { icon: $("#itemEditForm").icon.value.trim() || EDIT_KINDS[editKind].icon, image: editImage });
  $("#itemImageClear").classList.toggle("hidden", !editImage);
}

// Crop to a square and shrink to a small JPEG, so images stay light inside the family data.
async function resizeImage(file, size = 192) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function openRecordEditor(rec) {
  const f = $("#recordEditForm");
  const d = new Date(rec.t);
  const p = (n) => String(n).padStart(2, "0");
  editingRecordId = rec.id;
  f.when.value = `${dateKey(d)}T${p(d.getHours())}:${p(d.getMinutes())}`;
  f.when.max = `${dateKey()}T23:59`;
  f.points.value = rec.points;
  $("#recordEditInfo").textContent = `${rec.name} · ${byText(rec.by) || "提交人未知"}`;
  openEditor("#recordEditor");
}

function bindEditors() {
  document.querySelectorAll("#itemEditor, #recordEditor, #passwordEditor").forEach((m) => {
    m.addEventListener("click", (e) => {
      if (e.target === m || e.target.closest("[data-close]")) closeEditors();
    });
  });
  addEventListener("keydown", (e) => e.key === "Escape" && closeEditors());

  const f = $("#itemEditForm");
  f.icon.addEventListener("input", updateItemPreview);
  f.name.addEventListener("input", updateAnimOptions);
  $("#animPreview").addEventListener("click", () =>
    celebrate({ name: f.name.value.trim(), anim: f.anim.value, points: clampInt(f.num.value, 1, 99) }),
  );
  $("#itemImageClear").addEventListener("click", () => {
    editImage = null;
    updateItemPreview();
  });
  $("#itemImageInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      editImage = await resizeImage(file);
      updateItemPreview();
    } catch {
      toast("这张图片打不开，换一张试试");
    }
  });

  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const k = EDIT_KINDS[editKind];
    const data = { icon: f.icon.value.trim() || k.icon, name: f.name.value.trim(), [k.numKey]: clampInt(f.num.value, 1, k.max) };
    if (!data.name) return;
    // Look the item up again: a family member's change may have replaced the state meanwhile.
    const list = k.list();
    const item = editingItemId && list.find((x) => x.id === editingItemId);
    if (editingItemId && !item) {
      toast(`这个${k.word}已经被家人删除了`);
    } else if (item) {
      Object.assign(item, data);
      if (editImage) item.image = editImage;
      else delete item.image;
    } else {
      list.push({ id: newId(k.prefix), ...data, ...(editImage ? { image: editImage } : {}) });
    }
    if (editKind === "task" && (item || !editingItemId)) {
      const saved = item || list[list.length - 1]; // the task just added
      if (f.anim.value) saved.anim = f.anim.value;
      else delete saved.anim; // automatic: follows the task name
    }
    closeEditors();
    save();
    render();
    if (!editingItemId || item) toast(`${k.word}已${item ? "保存" : "添加"} ✅`);
  });

  $("#recordEditForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const rf = e.target;
    const t = new Date(rf.when.value).getTime(); // datetime-local values are parsed as local time
    if (!Number.isFinite(t)) return;
    if (t > Date.now() + 60e3) return toast("不能选将来的时间");
    const rec = state.records.find((r) => r.id === editingRecordId);
    closeEditors();
    if (!rec) return toast("这条记录已经被家人删除了");
    updateRecord(rec, { t, points: clampInt(rf.points.value, 0, 99) });
    save();
    render();
    toast("记录已修改 ✅");
  });
}

/* ---------------- UI helpers ---------------- */

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
  if (name === "parent") renderParent();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Celebrations can overlap (task bonus, new badge), so show modals one after another.
const modalQueue = [];
function openModal(...args) {
  modalQueue.push(args);
  if (modalQueue.length === 1) showModal(...args);
}

function showModal(icon, title, text, buttons) {
  $("#modalIcon").textContent = icon;
  $("#modalTitle").textContent = title;
  $("#modalText").textContent = text;
  const box = $("#modalBtns");
  box.innerHTML = "";
  for (const [label, cls, fn] of buttons) {
    const b = document.createElement("button");
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.addEventListener("click", () => {
      $("#modal").classList.add("hidden");
      modalQueue.shift();
      fn?.();
      if (modalQueue.length) showModal(...modalQueue[0]);
    });
    box.append(b);
  }
  $("#modal").classList.remove("hidden");
}

function infoModal(icon, title, text) {
  openModal(icon, title, text, [["好的", "primary"]]);
}

function confirmModal(icon, title, text, okLabel, onOk) {
  openModal(icon, title, text, [
    ["再想想", ""],
    [okLabel, "primary", onOk],
  ]);
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

function randomCheer() {
  return `${pick(["真棒", "好厉害", "继续加油", "你做到了", "了不起", "太优秀了"])}！`;
}

function flyStars(fromEl, count) {
  const from = fromEl.getBoundingClientRect();
  const to = $("#balance").getBoundingClientRect();
  for (let i = 0; i < count; i++) {
    const s = document.createElement("div");
    s.className = "fly-star";
    s.textContent = "⭐";
    const x = from.left + from.width * (0.6 + Math.random() * 0.3);
    const y = from.top + from.height / 2 - 14;
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    document.body.append(s);
    setTimeout(() => {
      s.style.transform = `translate(${to.left + to.width / 2 - x - 14}px, ${to.top - y}px) scale(0.6)`;
      s.style.opacity = "0.2";
    }, 30 + i * 80);
    setTimeout(() => s.remove(), 900 + i * 80);
  }
}

/* ---------------- effects: fireworks, confetti, red envelope ---------------- */

// One canvas particle loop shared by confetti and fireworks, so they can overlap without flicker.
const fx = { parts: [], running: false, ctx: null };

function fxStart() {
  if (fx.running) return;
  const canvas = $("#confetti");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  fx.ctx = canvas.getContext("2d");
  fx.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fx.running = true;
  requestAnimationFrame(fxFrame);
}

function fxFrame() {
  const ctx = fx.ctx;
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  const born = [];
  for (const p of fx.parts) {
    p.life -= 1;
    if (FX_KINDS[p.kind]) {
      FX_KINDS[p.kind](ctx, p, born);
      continue;
    }
    if (p.kind === "rocket") {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += ROCKET_GRAVITY;
      ctx.fillStyle = "#fff6c2";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      born.push({ kind: "spark", x: p.x, y: p.y + 4, vx: (Math.random() - 0.5) * 0.6, vy: 1, life: 14, max: 14, color: "#ffcf6e", size: 1.6 });
      if (p.vy >= -1 || p.life <= 0) {
        p.life = 0;
        born.push(...burst(p.x, p.y, p.color));
      }
      continue;
    }
    p.vy += p.kind === "confetti" ? 0.35 : 0.06;
    p.vx *= p.kind === "confetti" ? 0.99 : 0.97;
    p.vy *= p.kind === "confetti" ? 1 : 0.97;
    p.x += p.vx;
    p.y += p.vy;
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life / (p.max * 0.5)));
    ctx.fillStyle = p.color;
    if (p.kind === "confetti") {
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  fx.parts = fx.parts.filter((p) => p.life > 0 && p.y < innerHeight + 40).concat(born);
  if (fx.parts.length) requestAnimationFrame(fxFrame);
  else {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    fx.running = false;
  }
}

// Particle kinds used by the task celebrations; each one moves and draws itself.
const FX_KINDS = {
  // Soap bubble that floats up, sways, and pops ("啵") when its life runs out.
  bubble(ctx, p, born) {
    p.t += 1;
    p.x += p.vx + Math.sin(p.t * p.freq) * p.sway;
    p.y += p.vy;
    p.vx *= 0.99;
    const r = p.r * Math.min(1, p.t / 10);
    const g = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.35, r * 0.1, p.x, p.y, r);
    g.addColorStop(0, "rgba(255,255,255,0.55)");
    g.addColorStop(0.7, `hsla(${p.hue},90%,85%,0.18)`);
    g.addColorStop(1, `hsla(${p.hue + 60},90%,70%,0.35)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `hsla(${p.hue + p.t * 2},80%,65%,0.75)`;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.ellipse(p.x - r * 0.4, p.y - r * 0.45, r * 0.22, r * 0.12, -0.6, 0, Math.PI * 2);
    ctx.fill();
    if (p.life <= 0) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        born.push({ kind: "spark", x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, vx: Math.cos(a) * 2, vy: Math.sin(a) * 2, life: 16, max: 16, size: 1.8, color: `hsl(${p.hue},90%,80%)` });
      }
      popSound();
    }
  },
  // Emoji or short text thrown up like a fountain, spinning and falling back down.
  emoji(ctx, p) {
    p.t += 1;
    p.vy += p.g;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    const grow = Math.min(1, p.t / 8);
    ctx.save();
    ctx.globalAlpha = Math.min(1, p.life / 20);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.font = `900 ${p.size * grow}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = p.color || "#000";
    ctx.fillText(p.text, 0, 0);
    ctx.restore();
  },
  // Sparkle that appears in place, twinkles, and fades.
  twinkle(ctx, p) {
    p.t += 1;
    const k = Math.sin((p.t / p.max) * Math.PI);
    ctx.save();
    ctx.globalAlpha = k;
    ctx.font = `${p.size * (0.6 + 0.4 * k)}px system-ui, "Apple Color Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(p.text, p.x, p.y);
    ctx.restore();
  },
};

let lastPop = 0;
function popSound() {
  const now = performance.now();
  if (now - lastPop < 45) return; // many bubbles popping together become a quick 啵啵啵, not noise
  lastPop = now;
  playSound("pop");
}

const rand = (a, b) => a + Math.random() * (b - a);

function spawnBubbles(cx, cy, n = 30) {
  for (let i = 0; i < n; i++) {
    setTimeout(() => {
      fx.parts.push({ kind: "bubble", x: cx + rand(-30, 30), y: cy + rand(-10, 10), vx: rand(-2.2, 2.2), vy: rand(-3.8, -1.6), sway: rand(0.4, 1.4), freq: rand(0.04, 0.09), t: 0, r: rand(8, 26), life: rand(55, 120), hue: rand(0, 360) });
      fxStart();
    }, i * 40);
  }
}

function spawnFountain(cx, cy, items, n = 22) {
  for (let i = 0; i < n; i++) {
    setTimeout(() => {
      const it = pick(items);
      const [text, color] = Array.isArray(it) ? it : [it];
      // Thrown sideways from below the kid's face so nothing lands on it.
      fx.parts.push({ kind: "emoji", text, color, x: cx + rand(-20, 20), y: cy + 50, vx: (Math.random() < 0.5 ? -1 : 1) * rand(3, 6.5), vy: rand(-13, -7), g: 0.32, rot: rand(-0.4, 0.4), vr: rand(-0.08, 0.08), size: rand(26, 44), t: 0, life: 110 });
      fxStart();
    }, i * 45);
  }
}

function spawnTwinkles(items, n = 26, area = { x: 0, y: 0, w: innerWidth, h: innerHeight }) {
  for (let i = 0; i < n; i++) {
    setTimeout(() => {
      const life = rand(45, 90);
      fx.parts.push({ kind: "twinkle", text: pick(items), x: area.x + rand(0, area.w), y: area.y + rand(0, area.h), size: rand(18, 36), t: 0, life, max: life });
      fxStart();
    }, i * 50);
  }
}

// Balloons and friends' toys drifting up into the sky.
function spawnFloaters(cx, cy, items, n = 18) {
  for (let i = 0; i < n; i++) {
    setTimeout(() => {
      // Rise along the left and right edges, drifting outward, so balloons never cover the kids' faces.
      const side = i % 2 ? 1 : -1;
      const x = Math.min(innerWidth - 20, Math.max(20, cx + side * rand(150, 200)));
      fx.parts.push({ kind: "emoji", text: pick(items), x, y: cy + rand(40, 180), vx: side * rand(0.2, 0.9), vy: rand(-4, -2.2), g: -0.03, rot: rand(-0.2, 0.2), vr: rand(-0.01, 0.01), size: rand(28, 46), t: 0, life: 130 });
      fxStart();
    }, i * 60);
  }
}

// Floating "Z z z" for the bedtime animation.
function spawnZzz(x, y) {
  for (let i = 0; i < 5; i++) {
    setTimeout(() => {
      fx.parts.push({ kind: "emoji", text: i % 2 ? "z" : "Z", color: "#cfe3ff", x, y, vx: rand(0.8, 1.6), vy: -1.6, g: 0, rot: rand(-0.2, 0.2), vr: 0, size: 22 + i * 6, t: 0, life: 90 });
      fxStart();
    }, i * 260);
  }
}

const ROCKET_GRAVITY = 0.25; // rockets reach the top of the screen in about a second
const FX_COLORS = ["#ff9f43", "#ffd23f", "#2ecc71", "#54a0ff", "#ff6b9d", "#a55eea", "#ff4757"];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function burst(x, y, color) {
  const n = 70;
  return Array.from({ length: n }, (_, i) => {
    const angle = (i / n) * Math.PI * 2 + Math.random() * 0.2;
    const speed = 2.5 + Math.random() * 3.5;
    const life = 55 + Math.random() * 30;
    return { kind: "spark", x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life, max: life, size: 2 + Math.random() * 1.5, color: Math.random() < 0.8 ? color : "#fff" };
  });
}

// Launch rockets from the bottom that explode at (x, y); positions default to the upper screen.
function fireworks(count = 3, { spread = 300, sound = true } = {}) {
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      const x = innerWidth / 2 + (Math.random() - 0.5) * Math.min(spread * 2, innerWidth * 0.9);
      const y = innerHeight * (0.15 + Math.random() * 0.25);
      const vy = -Math.sqrt(2 * ROCKET_GRAVITY * (innerHeight - y)); // just enough speed to peak at y
      fx.parts.push({ kind: "rocket", x, y: innerHeight, vx: (Math.random() - 0.5) * 1.2, vy, life: 200, color: pick(FX_COLORS) });
      fxStart();
      if (sound) playSound("firework");
    }, i * 380);
  }
}

function confetti() {
  for (let i = 0; i < 140; i++) {
    fx.parts.push({
      kind: "confetti",
      x: innerWidth / 2,
      y: innerHeight / 3,
      vx: (Math.random() - 0.5) * 14,
      vy: -Math.random() * 12 - 4,
      size: 6 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      life: 150,
      max: 300,
      color: pick(FX_COLORS),
    });
  }
  fxStart();
}

// A red envelope pops up, shakes, opens and shows the stars earned, then the stars fly to the wallet.
function redEnvelope(points, cheer) {
  document.querySelectorAll(".rp-overlay, .scene-overlay").forEach((o) => o.remove()); // quick taps: show only the newest one
  const overlay = document.createElement("div");
  overlay.className = "rp-overlay";
  overlay.innerHTML = `
    <div class="rp">
      <div class="rp-card"><small>${cheer}</small><b>+${points}<span>⭐</span></b></div>
      <div class="rp-body"></div>
      <div class="rp-flap"><div class="rp-seal">奖</div></div>
    </div>`;
  document.body.append(overlay);
  playSound("redPacket");
  setTimeout(() => {
    overlay.classList.add("open");
    playSound("coins");
    fireworks(2, { spread: 140, sound: false });
  }, 650);
  setTimeout(() => flyStars(overlay.querySelector(".rp-card"), Math.min(points, 6)), 1150);
  setTimeout(() => overlay.classList.add("leave"), 1500);
  setTimeout(() => overlay.remove(), 1900);
}

/* ---------------- task celebrations: a kid doing the task, themed particles and sounds ---------------- */

// Matched against the task name in this order ("午饭刷牙" must be brushing, not eating).
// Each theme has an illustration in assets/anim/<key>.webp and a sound in SOUNDS[<key>].
const THEMES = {
  brush: { label: "刷牙泡泡", words: ["刷牙", "漱口"], motion: "wiggle", praise: ["牙齿亮晶晶！", "刷得真干净！", "泡泡飞上天啦！"],
    play: ({ cx, cy, size }) => spawnBubbles(cx, cy + size * 0.05) },
  kindergarten: { label: "幼儿园一起玩", words: ["幼儿园", "上学", "学校", "托班"], motion: "dance", praise: ["和小朋友玩得真开心！", "幼儿园真好玩！", "交到好朋友啦！"],
    play: ({ cx, cy }) => { spawnFloaters(cx, cy, ["🎈", "🎈", "🎈", "🪁", "🌈", "💖", "⭐"]); spawnTwinkles(["✨", "💫"], 14); } },
  sleep: { label: "睡觉", words: ["睡"], motion: "breathe", praise: ["早睡早起身体好！", "做个甜甜的梦！"],
    play: ({ cx, cy, size }) => { spawnZzz(cx + size * 0.25, cy - size * 0.25); spawnTwinkles(["⭐", "✨", "🌟"], 30); } },
  homework: { label: "写作业", words: ["作业", "写字", "练字", "功课", "数学", "英语", "算术", "学", "写"], motion: "nod", praise: ["作业完成啦！", "认真学习的好孩子！"],
    play: ({ cx, cy }) => spawnFountain(cx, cy, ["💯", "✏️", "⭐", "📝", ["A+", "#e53935"], ["100", "#e53935"]]) },
  read: { label: "读书", words: ["读", "阅读", "绘本", "书", "故事"], motion: "tilt", praise: ["读书真棒！", "又学到新知识啦！", "故事真好听！"],
    play: ({ cx, cy, size }) => spawnFountain(cx, cy + size * 0.2, ["⭐", "✨", "🦋", "🌈", "🦕", "🏰", ["A", "#54a0ff"], ["B", "#ff6b9d"], ["乐", "#2ecc71"]]) },
  sport: { label: "运动", words: ["跳绳", "运动", "跑", "球", "游泳", "锻炼", "骑车", "跳"], motion: "bounce", praise: ["身体棒棒！", "运动小健将！"],
    play: ({ cx, cy }) => spawnFountain(cx, cy, ["💪", "⚡", "❤️", "⭐", "💦", "🏅"], 26) },
  tidy: { label: "收拾整理", words: ["收拾", "整理", "打扫", "玩具", "叠", "扫"], motion: "shake", praise: ["房间亮堂堂！", "收拾小能手！"],
    play: ({ cx, cy }) => { spawnTwinkles(["✨", "🌟", "💫", "⭐"], 34); spawnFountain(cx, cy, ["🧸", "🧩", "⚽", "🚗"], 10); } },
  dress: { label: "穿衣服", words: ["穿衣", "衣服", "穿"], motion: "pop", praise: ["自己穿衣真能干！", "穿得真整齐！"],
    play: ({ cx, cy }) => spawnFountain(cx, cy, ["👕", "👖", "🧦", "🧢", "👟", "🧤", "✨"]) },
  eat: { label: "吃饭", words: ["吃", "饭", "餐", "喝"], motion: "nod", praise: ["吃得香香的！", "光盘小能手！", "长高高啦！"],
    play: ({ cx, cy }) => spawnFountain(cx, cy, ["🍚", "🥦", "🌽", "🍗", "🥕", "🍎", "🥚", "🍅", "🥛", "💧"]) },
};

// A task's animation: chosen in the editor (task.anim), otherwise matched from its name.
// "envelope" or no match plays the red envelope.
function themeFor(task) {
  if (task.anim) return THEMES[task.anim] ? task.anim : null;
  return Object.keys(THEMES).find((k) => THEMES[k].words.some((w) => task.name.includes(w))) || null;
}

function celebrate(task) {
  const key = themeFor(task);
  if (!key) return redEnvelope(task.points, randomCheer());
  const theme = THEMES[key];
  document.querySelectorAll(".rp-overlay, .scene-overlay").forEach((o) => o.remove()); // quick taps: newest only
  const overlay = document.createElement("div");
  overlay.className = `scene-overlay theme-${key}`;
  overlay.innerHTML = `
    <div class="scene">
      <img class="scene-kid m-${theme.motion}" alt="" src="assets/anim/${key}.webp" />
      <div class="scene-label"><small></small><b>+${task.points}<span>⭐</span></b></div>
    </div>`;
  overlay.querySelector(".scene-label small").textContent = pick(theme.praise);
  document.body.append(overlay);
  playSound(key);
  const kid = overlay.querySelector(".scene-kid");
  const r = kid.getBoundingClientRect(); // centered; the pop-in scale does not move the center
  theme.play({ cx: r.left + r.width / 2, cy: r.top + r.height / 2, size: kid.offsetWidth });
  setTimeout(() => playSound("coins"), 850);
  setTimeout(() => flyStars(overlay.querySelector(".scene-label"), Math.min(task.points, 6)), 1500);
  setTimeout(() => overlay.classList.add("leave"), 2300);
  setTimeout(() => overlay.remove(), 2700);
}

// Warm the image cache so the first celebration shows its picture immediately.
function preloadThemes() {
  for (const key of Object.keys(THEMES)) new Image().src = `assets/anim/${key}.webp`;
}

/* ---------------- sounds (synthesized with Web Audio, no audio files) ---------------- */

const SOUND_KEY = "star-hero-sound";
let soundOn = localStorage.getItem(SOUND_KEY) !== "off";
let audioCtx;
let noiseBuffer;

function audio() {
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  if (!noiseBuffer) {
    noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return audioCtx;
}

function tone(freq, start, dur, { type = "triangle", vol = 0.15, slideTo } = {}) {
  const ac = audioCtx;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(vol, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

function noise(start, dur, { vol = 0.3, filter = "lowpass", freq = 1000, freqTo, q = 1, attack = 0.005 } = {}) {
  const ac = audioCtx;
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer;
  const f = ac.createBiquadFilter();
  f.type = filter;
  f.Q.value = q;
  f.frequency.setValueAtTime(freq, start);
  if (freqTo) f.frequency.exponentialRampToValueAtTime(freqTo, start + dur);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(vol, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(f).connect(gain).connect(ac.destination);
  src.start(start, Math.random());
  src.stop(start + dur + 0.02);
}

const SOUNDS = {
  // "啵": a bubble popping — quick downward blip plus a tiny click.
  pop(t) {
    const f = rand(700, 1300);
    tone(f, t, 0.07, { type: "sine", vol: 0.22, slideTo: f * 0.35 });
    noise(t, 0.02, { vol: 0.05, filter: "highpass", freq: 4000 });
  },
  // Scrub-scrub of a toothbrush, then bubbly bloops rising.
  brush(t) {
    for (let i = 0; i < 6; i++) noise(t + i * 0.09, 0.07, { vol: 0.08, filter: "bandpass", freq: i % 2 ? 3200 : 2400, q: 3, attack: 0.02 });
    for (let i = 0; i < 4; i++) tone(rand(350, 500), t + 0.55 + i * 0.09, 0.12, { type: "sine", vol: 0.14, slideTo: rand(900, 1300) });
  },
  // "啊呜啊呜": two chomps, a crunch, then a happy "mmm".
  eat(t) {
    [0, 0.22].forEach((d) => {
      tone(330, t + d, 0.14, { type: "triangle", vol: 0.16, slideTo: 170 });
      noise(t + d + 0.05, 0.06, { vol: 0.06, filter: "bandpass", freq: 1800, q: 2 });
    });
    tone(392, t + 0.5, 0.25, { type: "sine", vol: 0.12, slideTo: 523 });
  },
  // Two page flips, then a magical chime.
  read(t) {
    [0, 0.18].forEach((d) => noise(t + d, 0.16, { vol: 0.12, filter: "highpass", freq: 1500, freqTo: 5000, attack: 0.04 }));
    [1047, 1319, 1568, 2093].forEach((f, i) => tone(f, t + 0.38 + i * 0.08, 0.35, { type: "sine", vol: 0.1 }));
  },
  // Pencil scribbles, then "ding ding" for a perfect score.
  homework(t) {
    for (let i = 0; i < 5; i++) noise(t + i * 0.07, 0.05, { vol: 0.07, filter: "bandpass", freq: rand(2500, 4000), q: 4 });
    tone(1568, t + 0.42, 0.3, { type: "sine", vol: 0.13 });
    tone(2093, t + 0.56, 0.45, { type: "sine", vol: 0.13 });
  },
  // Boing-boing-boing of jumping rope, with a whoosh of the rope.
  sport(t) {
    for (let i = 0; i < 3; i++) {
      tone(140, t + i * 0.24, 0.2, { type: "sine", vol: 0.22, slideTo: 620 });
      noise(t + i * 0.24 + 0.1, 0.12, { vol: 0.05, filter: "bandpass", freq: 900, freqTo: 2400, q: 2, attack: 0.05 });
    }
  },
  // Rising sparkle glissando.
  tidy(t) {
    [1047, 1175, 1319, 1568, 1760, 2093, 2349, 2637].forEach((f, i) => tone(f, t + i * 0.05, 0.25, { type: "sine", vol: 0.12 }));
  },
  // Whoosh of putting clothes on, then "ta-da!".
  dress(t) {
    noise(t, 0.3, { vol: 0.1, filter: "bandpass", freq: 500, freqTo: 3000, q: 1.5, attack: 0.12 });
    tone(523, t + 0.32, 0.15, { vol: 0.14 });
    [659, 784, 1047].forEach((f) => tone(f, t + 0.48, 0.5, { vol: 0.1 }));
  },
  // Bouncy playground xylophone tune with giggly trills.
  kindergarten(t) {
    [523, 659, 784, 1047, 784, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.11, 0.18, { vol: 0.14 }));
    for (let i = 0; i < 3; i++) {
      tone(1400, t + 0.95 + i * 0.12, 0.08, { type: "sine", vol: 0.08, slideTo: 1900 });
      tone(1900, t + 1.01 + i * 0.12, 0.06, { type: "sine", vol: 0.06, slideTo: 1500 });
    }
  },
  // Soft lullaby with a twinkle.
  sleep(t) {
    [659, 587, 523, 587, 659, 659, 659].forEach((f, i) => tone(f, t + i * 0.2, 0.32, { type: "sine", vol: 0.13 }));
    tone(2637, t + 1.5, 0.4, { type: "sine", vol: 0.04 });
  },
  // Bright two-note chime, like receiving a red packet.
  redPacket(t) {
    tone(1318, t, 0.18, { type: "sine", vol: 0.2 });
    tone(1976, t + 0.09, 0.5, { type: "sine", vol: 0.2 });
    tone(3951, t + 0.09, 0.35, { type: "sine", vol: 0.05 });
  },
  // Coins tumbling out when the envelope opens.
  coins(t) {
    tone(988, t, 0.08, { type: "square", vol: 0.1 });
    tone(1319, t + 0.08, 0.45, { type: "square", vol: 0.1 });
    for (let i = 0; i < 6; i++) tone(2600 + Math.random() * 2400, t + 0.12 + i * 0.06 + Math.random() * 0.03, 0.12, { type: "sine", vol: 0.09 });
  },
  // Whistling launch, boom, then crackles.
  firework(t) {
    noise(t, 1.05, { vol: 0.08, filter: "bandpass", freq: 600, freqTo: 3000, q: 8, attack: 0.4 });
    const boom = t + 1.1;
    noise(boom, 1.1, { vol: 0.5, filter: "lowpass", freq: 1800, freqTo: 120 });
    tone(110, boom, 0.5, { type: "sine", vol: 0.35, slideTo: 40 });
    for (let i = 0; i < 14; i++) noise(boom + 0.25 + Math.random() * 0.9, 0.03, { vol: 0.12 + Math.random() * 0.1, filter: "highpass", freq: 2500 + Math.random() * 3000 });
  },
  win(t) {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.12, 0.35, { vol: 0.15 }));
    tone(1568, t + 0.48, 0.6, { type: "sine", vol: 0.08 });
  },
  ding(t) {
    tone(880, t, 0.25);
    tone(1320, t + 0.1, 0.3);
  },
  nope(t) {
    tone(220, t, 0.2, { type: "square", vol: 0.1 });
    tone(180, t + 0.12, 0.25, { type: "square", vol: 0.1 });
  },
};

function playSound(kind) {
  if (!soundOn) return;
  try {
    SOUNDS[kind](audio().currentTime + 0.01);
  } catch {}
}

function updateSoundBtn() {
  $("#soundBtn").textContent = soundOn ? "🔊" : "🔇";
  $("#soundBtn").title = soundOn ? "关闭声音" : "打开声音";
}

/* ---------------- login & family ---------------- */

let authMode = "login";

function showAuth(message = "") {
  $("#app").classList.add("hidden");
  $("#authScreen").classList.remove("hidden");
  $("#authError").textContent = message;
}

async function enterApp(profile) {
  me = profile;
  members = [];
  parentUnlocked = false;
  newLockQuestion();
  state = structuredClone(DEFAULT_STATE); // never show the previous family's data, even briefly
  render();
  $("#authScreen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  showTab("tasks");
  try {
    await load();
  } catch {
    if (!me) return;
    toast("⚠️ 连不上服务器，数据暂时不会保存");
  }
  render();
}

async function start() {
  try {
    const res = await fetch("/api/me", { cache: "no-store" });
    if (res.ok) return enterApp(await res.json());
    showAuth();
  } catch {
    showAuth("连不上服务器，请稍后再试");
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const f = $("#authForm");
  const register = mode === "register";
  document.querySelectorAll(".auth-tabs button").forEach((x) => x.classList.toggle("active", x.dataset.mode === mode));
  f.classList.toggle("login", !register);
  f.familyName.required = register;
  f.role.required = register;
  f.password.autocomplete = register ? "new-password" : "current-password";
  $("#authSubmit").textContent = register ? "创建家庭并登录" : "登录";
  $("#authNote").textContent = register
    ? "创建后可以在「家长」里为妈妈、爷爷奶奶等家人添加账号"
    : "爸爸妈妈用自己的账号登录，看到的是同一个家庭的数据";
  $("#authError").textContent = "";
}

// Quick-pick buttons that fill a role input (爸爸, 妈妈, ...).
function bindRoleChips(form) {
  const input = form.querySelector(".role-input");
  const box = form.querySelector(".role-chips");
  const sync = () => box.querySelectorAll("button").forEach((b) => b.classList.toggle("sel", b.textContent === input.value.trim()));
  for (const opt of $("#roleList").options) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = opt.value;
    b.addEventListener("click", () => {
      input.value = opt.value;
      sync();
    });
    box.append(b);
  }
  input.addEventListener("input", sync);
  form.addEventListener("reset", () => setTimeout(sync));
}

async function loadMembers() {
  try {
    const res = await api("/api/family");
    const family = await res.json();
    members = family.members;
    me.family.name = family.name;
    me.admin = !!members.find((m) => m.me)?.admin;
  } catch {}
  renderMembers();
}

function renderMembers() {
  $("#familyName").textContent = me.family.name;
  // Only the admin (the family's first account) can add or remove members.
  const admin = members.find((m) => m.admin);
  $("#addMemberForm").classList.toggle("hidden", !me.admin);
  $(".member-hint").textContent = me.admin
    ? "你是管理员，可以给家人添加账号。每个人用自己的账号登录，看到和管理的是同一份数据。"
    : `只有管理员${admin ? `（${admin.role} ${admin.username}）` : ""}可以添加或移除家庭成员。`;
  const ul = $("#memberList");
  ul.innerHTML = "";
  for (const m of members) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="e-role"></span><span class="e-name"></span>`;
    li.querySelector(".e-role").textContent = m.role;
    li.querySelector(".e-name").textContent = m.username;
    if (m.admin) li.querySelector(".e-name").insertAdjacentHTML("beforeend", ` <span class="e-admin">管理员</span>`);
    if (m.me) {
      li.insertAdjacentHTML("beforeend", `<span class="e-me">（我）</span>`);
    } else if (me.admin) {
      const del = document.createElement("button");
      del.className = "btn small danger";
      del.textContent = "移除";
      del.addEventListener("click", () =>
        confirmModal("👋", `移除「${m.role}」的账号？`, `${m.username} 将不能再登录这个家庭`, "移除", async () => {
          try {
            const res = await api(`/api/family/members/${encodeURIComponent(m.username)}`, { method: "DELETE" });
            if (!res.ok) throw new Error((await res.json()).error);
            toast("已移除");
          } catch (err) {
            toast(err.message);
          }
          loadMembers();
        }),
      );
      li.append(del);
    }
    ul.append(li);
  }
}

function bindAuth() {
  document.querySelectorAll(".auth-tabs button").forEach((b) => b.addEventListener("click", () => setAuthMode(b.dataset.mode)));
  bindRoleChips($("#authForm"));
  bindRoleChips($("#addMemberForm"));

  $("#authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const creds = { username: f.username.value.trim(), password: f.password.value };
    const register = authMode === "register";
    $("#authSubmit").disabled = true;
    try {
      const res = await fetch(register ? "/api/families" : "/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(register ? { ...creds, familyName: f.familyName.value.trim(), role: f.role.value.trim() } : creds),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      f.reset();
      setAuthMode("login");
      await enterApp(body);
    } catch (err) {
      $("#authError").textContent = err.message || "连不上服务器，请稍后再试";
    } finally {
      $("#authSubmit").disabled = false;
    }
  });

  $("#addMemberForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const res = await api("/api/family/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: f.role.value.trim(), username: f.username.value.trim(), password: f.password.value }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      infoModal("🎉", `已添加「${f.role.value.trim()}」`, `用户名 ${f.username.value.trim()}，用刚才设置的密码登录就能看到同一份数据`);
      f.reset();
      loadMembers();
    } catch (err) {
      toast(err.message || "添加失败，请稍后再试");
    }
  });

  $("#passwordBtn").addEventListener("click", () => {
    const f = $("#passwordForm");
    f.reset();
    $("#passwordError").textContent = "";
    $("#passwordAccount").textContent = `账号：${me.username}（${me.role}）`;
    openEditor("#passwordEditor");
  });

  $("#passwordForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.newPassword.value !== f.confirmPassword.value) {
      $("#passwordError").textContent = "两次输入的新密码不一样";
      return;
    }
    try {
      const res = await api("/api/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword: f.oldPassword.value, newPassword: f.newPassword.value }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      closeEditors();
      infoModal("🔑", "密码已修改", "下次登录请用新密码。其他设备上的这个账号需要重新登录。");
    } catch (err) {
      $("#passwordError").textContent = err.message || "修改失败，请稍后再试";
    }
  });

  $("#logoutBtn").addEventListener("click", async () => {
    if (saveTimer) await flushSave();
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    me = null;
    showAuth();
  });
}

/* ---------------- init ---------------- */

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
$("#avatarBtn").addEventListener("click", () => {
  state.avatar = AVATARS[(AVATARS.indexOf(state.avatar) + 1) % AVATARS.length];
  save();
  render();
});
$("#soundBtn").addEventListener("click", () => {
  soundOn = !soundOn;
  localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off");
  updateSoundBtn();
  playSound("ding");
});
updateSoundBtn();
preloadThemes();
bindParent();
bindAuth();
start();

// Every 30s: sync changes from other family members, and re-render after midnight for a new day.
let lastDay = dateKey();
setInterval(() => {
  refresh();
  if (dateKey() !== lastDay) {
    lastDay = dateKey();
    render();
  }
}, 30000);
